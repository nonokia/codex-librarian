# フレームワーク規約ディスパッチ解決ベースライン — issue #43 (ADR-9)

日付: 2026-07-15 / 対象: `eval/fixtures/cake-taskflow`(CakePHP-shaped、5 files / 25 symbols /
21 edges、うち unresolved 6 — dispatches 4 本を含む)/ 正解セット:
`eval/golden/cake-taskflow.json`(4 ケース、11 expected)

## 何を作ったか

CakePHP のコードベースで「各アクションの呼び出し順序 / 画面遷移フロー」を答えられなかったのは
retrieval の設定ではなく、**そもそもグラフにその遷移エッジが無かった**から(発端は #43)。

```php
return $this->redirect(['controller' => 'Foo', 'action' => 'bar']);
```

`'bar'` が `FooController::bar()` を指すのは PHP の文法ではなく **CakePHP の実行時ディスパッチ
規約**であり、汎用パーサ(nikic/php-parser)は関知しない。ADR-9 はこれを新エッジ種別
`dispatches` としてグラフに乗せ、ADR-8 の `link` と同型の二段構えで解決する:

- **Step 0(抽出器)**: php-extractor が `redirect([...])` / `setAction('x')` を検出し、
  `resolved=false`・`dispatch <controller>#<action>` という**事実だけ**を吐く(規約の適用も
  クラス解決もしない)。
- **Step 1(後段)**: `librarian resolve-dispatches` が CakePHP の命名規約
  (`['controller'=>'Foo']` → クラス `FooController`、`['action'=>'bar']` → その public メソッド
  `bar`)で束縛する。**推測ではなく規約**:対象が無ければ `resolved=0` のまま、同名 controller が
  複数ファイルにあれば**繋がず拒否**。

```bash
librarian index eval/fixtures/cake-taskflow --db idx.db
librarian resolve-dispatches --db idx.db
# {"newlyResolved":4,"resolvedDispatches":4,
#  "byController":{"TasksController":3,"ReportsController":1},
#  "ambiguous":[],"missingTargets":[],"dryRun":false}
```

## 抽出器が何を名乗るか(規約の適用は抽出器の仕事では**ない**)

抽出器は runtime に見える文字列(controller 値・action 値)だけを記録し、`<name>Controller` の
規約適用や public 判定は後段に委ねる。`link` の `<spec>#<imported>` 由来 binding と同じ「参照点は
事実だけ名乗り、写像は後段が持つ」設計:

| 抽出されるエッジ(すべて resolved=0) | ソース |
| --- | --- |
| `dispatch Tasks#view` | `redirect(['controller'=>'Tasks','action'=>'view'])`(明示 controller) |
| `dispatch Tasks#view` | 別アクションの `setAction('view')`(controller は囲みクラスの規約名) |
| `dispatch Tasks#add` | `redirect(['action'=>'add'])`(controller 省略 → 同一 controller) |
| `dispatch Reports#summary` | `redirect(['controller'=>'Reports','action'=>'summary'])`(cross-controller) |
| `dispatch Foo#index` | `redirect(['controller'=>'Foo'])`(action 省略 → CakePHP 既定の `index`) |

`resolve-dispatches` は `Tasks` に `Controller` を足して `TasksController` を引き、その
public メソッド `view` に結ぶ。プラグイン/prefix 付きの `Admin/Users` は最終セグメントを取って
`UsersController`。リテラル文字列でないルーティング(`redirect($url)`、変数 controller)は
抽出器が**そもそも吐かない**(静的解決不可能、ADR-9 スコープ外)。

## ベースライン(hops=2, budget=8000, 既定戦略 — 全言語と同一)

同じ golden・同じインデックスで、**resolve-dispatches の有無だけ**を変えた A/B:

| 指標 | resolve なし(= #43 以前) | resolve あり |
| --- | --- | --- |
| micro recall | **0.273** (3/11) | **1.000** (11/11) |
| macro recall | 0.250 | 1.000 |
| perfect cases | 0 / 4 | 4 / 4 |
| mean items | 5.25 | 7.75 |
| mean chars | 953 | 1260 |
| resolved dispatches edges | 0 | 4 |

ケース別に何が取れていなかったか(resolve なし):

| case | 変更対象 | 取りこぼし | 型 |
| --- | --- | --- | --- |
| ctf-001 | `TasksController::add` | `view`(遷移先)とその先の `TaskStore::get` | 同一 controller redirect |
| ctf-002 | `TasksController::complete` | `index`(一覧へ戻る)とその先の `TaskStore::all` | 明示 controller redirect |
| ctf-003 | `TasksController::archive` | `ReportsController::summary` とその先の `ReportService::build`(**0 件**) | cross-controller redirect |
| ctf-004 | `TasksController::edit` | `view`(再描画)とその先の `TaskStore::get` | setAction |

resolve なしで取れている 3 件はすべて各アクションが直接呼ぶ `TaskStore::*`(通常の resolved
`calls`)。遷移先のアクションと、その先で初めて触るモデルメソッドはディスパッチ経由でしか
到達しないため、`dispatches` を解決するまでグラフから見えない。0.273 は「マルチ画面アプリを
index しただけでは画面遷移は原理的に見えない」という #43 以前の事実の数値化であって retrieval の
劣化ではない(ADR-8 の cross-repo と同じ構図)。

## 不変条件(検証済み — `src/test/dispatches.test.ts`)

- **リテラル文字列のみ検出**: `redirect($url)` / 変数 controller・action は `dispatches` を
  一切吐かない(genuinely dynamic、ADR-9 スコープ外)。
- **規約対象が無ければ解決しない**: `dispatch Foo#index` で `FooController::index` が無ければ
  `missingTargets` に出て `resolved=0` のまま(推測で最寄りに繋がない)。
- **曖昧は拒否**: 同名 controller クラスが複数ファイルにあれば `ambiguous` に出して繋がない。
- **冪等**: 2 回目の `resolve-dispatches` は `newlyResolved=0`、`resolvedDispatches` 不変。
- **可逆**: `--clear` は resolved 行を抽出器が吐いた unresolved 行そのものに戻す(生名
  `dispatch …` を `to_name` に保持)。`--dry-run` は集計だけで db を書き換えない。
- **既存言語の retrieval は不変**: `dispatches` は PHP の redirect/setAction でのみ発生し、
  他言語・通常の PHP には現れない。php-taskflow は #43 前後で **micro 88.1%(37/42)** 完全一致、
  dispatches エッジは 0 本(`src/test/extractor-php.test.ts` の記録値と一致)。追加されるエッジは
  すべて `resolved=0` で、解決前は BFS が辿らないため resolve 前のグラフも #43 以前と同一。

## 既知の限界(意図的 — Step 2 以降)

- **継承先アクションは繋がらない**: `resolve-dispatches` は controller クラスに**直接**宣言された
  メソッドだけを対象にする。親コントローラや trait 由来のアクションはレシーバ型解決が要るため
  対象外(`link` がメソッド越えを繋がないのと同じ理由)。
- **public 可視性は判定しない**: store はメソッドの可視性を持たないため、名前一致した
  `method` シンボルに結ぶ。CakePHP は private/protected をディスパッチしないが、fixture は
  public のみで衝突しない。厳密化は可視性の記録(symbols スキーマ拡張)が要る別作業。
- **他フレームワークは未対応**: Next.js ルーティング・Django/Flask 等への展開は各言語の
  fixture で match 率改善を計測した上で判断する(ADR-4、ADR-9 Step 2)。`dispatches` エッジ種別
  と `resolve-dispatches` の骨格は言語非依存なので、抽出器側の検出と後段の規約を足すだけで届く。
- **重み 0.85 は暫定**: `dispatches` の retrieval 重みは calls(1.0)と references(0.7)の中間の
  暫定値。最適値は PatternCache 掃引(ADR-4)に委ねる(#43 の未決事項「calls との差別化」)。
