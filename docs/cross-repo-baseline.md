# クロスリポ import 解決ベースライン — issue #27 (ADR-8)

日付: 2026-07-15 / 対象: `eval/fixtures/cross-repo`(2 repos / 7 files / 23 symbols / 49 edges、
うち unresolved 28)/ 正解セット: `eval/golden/cross-repo.json`(3 ケース、14 expected)

## 何を作ったか

複数リポジトリを 1 つの db に同居させること自体は #11 で済んでいた。足りなかったのは
**「`@acme/core` という import 指定子が、隣にインデックスされているあの repo のことだ」**
という 1 つの事実だけで、それはどちらの repo のツリーにも書かれていない。`librarian link`
はその事実だけを明示宣言(`links.json`)から受け取り、抽出器が開けたまま残した
(`resolved = 0`)エッジを再解決する。

```bash
librarian index eval/fixtures/cross-repo/acme-core --db idx.db --repo-name acme-core
librarian index eval/fixtures/cross-repo/acme-app  --db idx.db --repo-name acme-app
librarian link --db idx.db --map eval/fixtures/cross-repo/links.json
# {"packages":1,"newlyResolved":14,"crossRepoEdges":14,"byPackage":{"@acme/core":14},
#  "ambiguous":[],"missingTargets":[],"dryRun":false}
```

宣言はこれだけ:

```json
{ "packages": [ { "package": "@acme/core", "repo": "acme-core", "entry": "src/index.ts" } ] }
```

## どうやって呼び出し先を特定しているか(名前一致では**ない**)

素朴にやると、call site には `createTask()` という**生の名前**しか残らない。生名から
「どの package 由来か」を後で当てようとすると必ず偽エッジが出る(下記)。そこで **TS 抽出器が
参照点の時点で由来 package を名乗らせる** — 型チェッカが「この識別子は解決不能な import に
束縛されている」と分かる場合、エッジ名を局所名ではなく `<指定子>#<export 名>` にする:

| 抽出されるエッジ(すべて resolved=0) | 意味 |
| --- | --- |
| `imports @acme/core` | このファイルは指定子 `@acme/core` を import している |
| `imports @acme/core#createTask` | そこから `createTask` を binding している |
| `imports @acme/core#overdue as isOverdue` | 別名 binding |
| `calls @acme/core#createTask` | **その import を呼んでいる参照点**(生名ではない) |
| `calls add` | 何にも束縛されていない生名(= `seen.add(v)` のようなメソッド呼び出し) |

link は**修飾済みの名前しか解決しない**。宣言 `@acme/core → acme-core` を引き、対象 repo の
module-scope 宣言 `createTask` に結ぶ。同名宣言が 2 つあれば**曖昧として拒否**する
(`ambiguous[]` に出す)。

**なぜ「ファイル内の import を見て生名を突き合わせる」ではダメか**(実装中に実際に踏んだ):
`import { add } from '@acme/math'` を持つファイルの中で、その import を一切呼ばない関数が
`seen.add(v)`(Set のメソッド)を呼ぶと、call エッジの生名は同じ `add` になる。ファイル単位の
binding 表で突き合わせると、この関数から `@acme/math:add` への**存在しない呼び出し**が
resolved=1 で作られる。`get` / `set` / `add` / `create` のような名前で現実に起きる。
参照点に由来を名乗らせる方式ならメソッド呼び出しは生名のままなので、**偽エッジが構造的に
作れない**(回帰テスト: `src/test/link.test.ts` の「a method call that shares an export name
is never linked」)。

**リンクしないもの**(束縛が確定しないため `resolved = 0` のまま):
メソッド呼び出し、default / namespace import、宣言のない package(fixture の `node:crypto`
は宣言していないので手つかずのまま残る)。

## ベースライン(hops=2, budget=8000, 既定戦略 — 全言語と同一)

同じ golden・同じインデックスで、**link の有無だけ**を変えた A/B:

| 指標 | link なし(= #27 以前) | link あり |
| --- | --- | --- |
| micro recall | **0.429** (6/14) | **1.000** (14/14) |
| macro recall | 0.433 | 1.000 |
| perfect cases | 0 / 3 | 3 / 3 |
| mean items | 5.7 | 13.0 |
| mean chars | 798 | 2461 |
| cross-repo edges | 0 | 14 |

ケース別に何が取れていなかったか(link なし):

| case | 変更対象 | 取りこぼし |
| --- | --- | --- |
| crf-001 | `acme-core` の `overdue` | 利用側の呼び出し元 `overdueCount` / `overdueTitles`、その先の `handleOverdue` |
| crf-002 | `acme-core` の `createTask` | 利用側の `addTask` → `handleCreate` → 回帰テスト |
| crf-003 | `acme-app` の `addTask` | 依存先の契約(`createTask` / `MemStore`)— **呼び出し先方向も同じく取れていない** |

link なしで取れている 6 件はすべて同一 repo 内の近傍で、これは #27 以前の挙動と完全に一致する
(cross-repo エッジが 1 本も無い状態 = 抽出直後の状態)。0.429 は「マルチレポの db に入れた
だけでは、リポジトリを跨ぐ影響は原理的に見えない」という #27 以前の事実の数値化であって、
retrieval の劣化ではない。

## 不変条件(検証済み)

- **宣言が無ければ何も起きない**: `links.json` を渡さない/空宣言のとき `crossRepoEdges` は 0、
  `edges` テーブルは抽出直後とバイト単位で同一(`src/test/link.test.ts` で固定)。
- **既存言語の retrieval は不変**: 追加・改名されるのは `resolved = 0` のエッジだけで、BFS は
  unresolved を辿らない。既存の TS 正解セット(`eval/golden/weather-you-travel.json`, 16 ケース)
  を #27 の抽出器で再計測して **micro 87.0% / macro 87.5% / perfect 10-of-16 —
  `docs/phase0-report.md` の記録値と完全一致**(ADR-4 の回帰ゲート)。変わるのは
  unresolved 集計の見え方で、`librarian map` には `readFileSync` ではなく
  `node:fs#readFileSync` が並ぶ(どの外部 API を使っているかが読めるようになる副次効果)。
- **冪等**: 2 回目の `link` は `newlyResolved = 0`、`crossRepoEdges` 不変。
- **可逆**: `link --clear` は resolved 行を**抽出器が吐いた unresolved 行そのもの**に戻す
  (生名を `to_name` に保持しているため)。edges テーブルのハッシュが一致することを確認済み。
- **repo-unaware invariant(#11)は維持**: 抽出器は自分がどの repo かを知らない。binding
  エッジは「この指定子からこの名前を取った」という repo に依存しない事実だけを記録し、
  package → repo の写像は store/app 層(link)だけが持つ。

## 多言語対応(issue #35)

#27 時点では binding エッジを吐くのは TS 抽出器だけで、実機の複数リポジトリ index(Go /
PHP / Python のみ、TS を 1 つも含まない構成)で `librarian link` が cross-repo エッジを
ほぼ 0 本しか作れなかった。#35 で §8.1 の規約(`<specifier>#<imported>`)を **Go / Python /
PHP** の 3 抽出器へ展開した。link 側は言語を知らないまま — 唯一の変更は `forSpec()` の
subpath 区切りをエコシステム毎に広げたこと(TS/Go `/`・Python `.`・PHP `\`)。宣言済み
package にしか当てないので、区切りを増やしても未宣言 package への誤マッチは起きない。

各抽出器が use site をどう名乗るか(すべて `resolved=0`、方式は TS と同一 —「参照点が由来を
名乗る」ので link は名前表引きが要らない):

| 言語 | specifier の作り方 | 例(use site → toName) |
| --- | --- | --- |
| Go | `obj.Pkg().Path()`(型チェッカが持つ import path) | `task.CreateTask()` → `example.com/acme-core/task#CreateTask` |
| Python | `from pkg import name` の module パス(絶対 import で in-repo 解決不能なもの) | `create_task()` → `taskcore#create_task`、別名 `is_overdue()` → `taskcore#overdue` |
| PHP | NameResolver 済み FQN の namespace prefix | `new Task()` → `Acme\Core#Task`、`makeTask()` → `Acme\Core#makeTask` |

**メソッド呼び出しは 3 言語とも生名のまま**(型解決が要る): Go の `t.Touch()`、Python の
`_store.add(...)`、PHP の `$t->touch()` は `#` 修飾されないので構造的に link できない
(偽エッジが作れない、#27 と同じ不変条件)。

### Python ベースライン(`eval/fixtures/cross-repo-py`、golden `eval/golden/cross-repo-py.json`)

TS を 1 つも含まない 2 repo(`pycore` = package `taskcore` / `pyapp` = それを import する
利用側)。同じ golden・同じ index で **link の有無だけ**を変えた A/B(3 ケース、13 expected):

| 指標 | link なし | link あり |
| --- | --- | --- |
| micro recall | **0.462** (6/13) | **1.000** (13/13) |
| perfect cases | 0 / 3 | 3 / 3 |
| cross-repo edges | 0 | 14 |

link なしで取れている 6 件はすべて同一 repo 内の近傍で、これは #27 以前の TS と同じ
「マルチレポの db に入れただけでは repo を跨ぐ影響は原理的に見えない」の数値化。
回帰テストは `src/test/cross-repo-multilang.test.ts`(Python は committed fixture + golden、
Go/PHP は `replace`/namespace の inline ペアで cross-repo call が張られ・メソッド呼び出しが
張られないことを固定)。

### 無回帰(既存言語の eval)

binding エッジは **すべて `resolved=0`** で、BFS は unresolved を辿らないため、
単一 repo の retrieval match は不変: python-taskflow 40/42・go-taskflow 45/47・
php-taskflow 88.1% はいずれも #35 前後で一致(`src/test/extractor-{python,go,php}.test.ts`)。
変わるのは外部呼び出しの unresolved 名の見え方だけ(例: Go は `fmt.Errorf` → `fmt#Errorf`、
どの外部パッケージの何を使っているかが読めるようになる副次効果、TS の #27 と同じ)。

## 既知の限界(意図的)

- **Terraform はスコープ外**(#35)。HCL の module `source` が別 repo を指すのは参照グラフの
  別問題で、call graph 言語の import binding とは筋が違う(必要なら別 issue)。TS/Go/Python/PHP の
  4 言語が §8.1 を実装済み。吐かない言語では cross-repo 解決が起きないだけで degrade しない。
- **メソッド**は繋がらない。`store.add()` の `add` を repo B の `MemStore::add` に結ぶには
  レシーバの型解決が要り、それは link(store 層)ではなく抽出器の仕事。
- **再インデックスでリンクは消える**。`index` は変更ファイルのエッジを作り直すため、その
  ファイルの cross-repo エッジも unresolved に戻る。`index` の後は `link` を再実行する
  (CI では index → link を 1 セットにする)。この「消える」挙動は意図的で、link を index の
  中に隠すと index の決定性(同じツリー → 同じ行)が db 全体の状態に依存して壊れる。
