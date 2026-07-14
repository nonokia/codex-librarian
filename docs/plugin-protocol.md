# 抽出器プラグインプロトコル 設計 — issue #22(SCIP+ 契約の公開・レジストリ化)

ステータス: **実装済み(issue #22)**。ADR-7 は architecture.md §5 に反映済み。本文書は
プラグイン契約の living reference(封筒 JSON Schema・moniker 文法・conformance の束ね)。
実装判断は dlog に記録し、各ステップは ADR-4 の回帰ゲート(§11)を通過してから次へ進んだ。
本文書は scip-design.md(ADR-6 提案文書)の延長であり、そこで定めた SCIP+ 封筒契約を
**公開プラグインプロトコル**へ格上げしたもの。

## 1. 目的と、現状からの差分

librarian のコア価値は「コードと抽出済みインデックスを使ったソースの関連付け」
(store / retrieval)であり、コードのパース・抽出は**必要に応じて第三者が作成・追加できる
プラグイン**であるべき(issue #22)。

現状の Go / PHP は「サブプロセス + SCIP+ 封筒」という**事実上のプラグイン ABI** で既に動いて
いる。しかし:

- **発見・登録が `src/app/index.ts` にハードコード**されている(`defaultExtractors()` が
  `GoExtractor` / `PhpExtractor` を直接 `new` する)。第三者はコードを書き換えないと言語を
  足せない。
- **契約が分散**している(`src/protocol/extractor.ts` + `src/protocol/scip.ts` +
  `docs/scip-design.md`)。第三者が「これだけ読めばプラグインを書ける」単一の参照点が無い。
- **言語別アダプタが重複**している。`src/extractors/go.ts`(~137 行)と
  `src/extractors/php.ts`(~134 行)は、コマンド解決・claim 拡張子・言語名を除いて
  **ほぼ同一のプラミング**(spawn → `{root,files}` を stdin → SCIP+ 封筒を ingest → degrade)。

本 issue は、この事実上の ABI を**公開契約に格上げ**し、発見・登録・実行の規約を定める。
**新しい抽出方式を発明するのではなく、既にあるものを外に出す**のがスコープ。

## 2. すでにある土台(#16 の成果 — 本 issue はその延長)

以下は #16 で完成済みで、プラグイン公開の前提。**再設計しない。**

1. **ワイヤ契約 = SCIP+ 封筒**(scip-design.md §4.1)。子プロセス契約は stdin/stdout の単一
   JSON `{ scip, ext }`。protobuf 非依存(どの言語でもプラグインを書ける — PHP は手組み
   JSON で emit している実例がある)。
2. **moniker → id の決定的再計算**(scip-design.md §4.2)。プラグインは内部 id ハッシュ
   `h20(file::container::name::kind)` を byte-for-byte 再実装する必要がなく、moniker 文法
   (`librarian-<lang>` scheme)に従うだけでよい。**プラグイン公開の最大の障壁は #16 で
   撤去済み**。
3. **repo-unaware invariant**(#11)。プラグインは repo 次元を知らない。repo の付与と id の
   名前空間化は indexer の `namespaceIds`(`h20(repo::id)`)が唯一の場所。store が進化しても
   プラグインは壊れない。
4. **dispatch 優先度**(scip-design.md §4.5)。native 抽出器と外部 `.scip` の棲み分け
   (native が常に勝つ)・削除管轄の限定は実装済み。本プロトコルのレジストリ優先度設計の
   直接の入力。
5. **conformance の型**。eval golden fixture 方式(`eval/fixtures/go-taskflow` /
   `php-taskflow` / `python-taskflow` + `eval/golden/*.json`)がそのまま適合性テストキットの
   雛形になる。

## 3. 設計原則(この機能の不変条件)

1. **ワイヤ契約は SCIP+ 封筒そのもの。** プロトコルは新しいデータ形式を足さない。足すのは
   **発見・登録・実行(ハンドシェイク)の規約**だけ。
2. **明示登録のみ。** プラグイン = 任意コマンドの実行。発見はコミット可能・レビュー可能な
   宣言(`.librarian/extractors.json`)に限る。**PATH 規約による暗黙発見・自動ダウンロードは
   採らない**(§5、§7)。
3. **TS は in-process のまま特別扱い。** ADR-2 の anchor(TypeScript Compiler API)は
   サブプロセス化しない。プロトコルは**サブプロセスプラグイン**の規約であり、in-process
   実装(TS)はディスパッチ層が並置する別枠。
4. **後方互換は追加のみ。** 封筒スキーマは追加のみで進化させ、`--capabilities` の
   `protocolVersion` で major を交渉する。未知フィールドは無視(scip-design.md §4.4 の ext
   規約と同じ)。`--capabilities` 非対応の旧プラグインは protocolVersion 1 とみなす。
5. **store スキーマ不変。** プロトコルは抽出→store 間の契約。SQLite スキーマ
   (symbols/edges)には手を入れない(ADR-1 非衝突、scip-design.md 原則 5 の継承)。
6. **各ステップは eval 完全一致がゲート。** パイプラインは決定的なので「recall が下がらない」
   ではなく「eval の結果セットが載せ替え前後で**完全一致**する」ことを要求できる(§8)。
   既存 Go/PHP がレジストリ経由で動いても数値は 1 bit も動かない、が受け入れ条件。

## 4. レジストリ設計 — `.librarian/extractors.json`

### 4.1 モデル: 既定レジストリ + リポジトリレジストリのマージ

ディスパッチが使う抽出器集合は 3 層の合成:

```
[ TypeScriptExtractor (in-process, ADR-2) ]        // 常に先頭・上書き不可の既定枠(原則 3)
  +  既定レジストリ(Go / PHP のリファレンスプラグイン)  // コード内の default registry
  +  .librarian/extractors.json(第三者・追加・上書き)   // repo にコミットされる宣言
```

- **TS**(in-process)は常に存在し、サブプロセスレジストリの外。
- **Go / PHP** は「既定レジストリのエントリ」として表現する。各エントリは自分のコマンド解決
  ラダー(env var → PATH → `go run` フォールバック等、現行の resolver をそのまま保持)を
  持つ。→ **「Go/PHP がレジストリ経由で動く」**(受け入れ条件)を満たしつつ、利用者が
  同梱言語のために `extractors.json` を書く必要は無い。
- **`.librarian/extractors.json`** は第三者プラグインの追加、および既定エントリの上書き
  (例: `.go` を自前ビルドのバイナリに差し替え)に使う。

### 4.2 ファイル形式

```jsonc
{
  "version": 1,
  "extractors": [
    {
      "name": "librarian-rust",     // scheme 名。moniker の <scheme> / ToolInfo.name と一致
      "extensions": [".rs"],        // 拡張子 → このコマンドへ明示ルーティング(発見はこれで足りる)
      "command": "librarian-rust-extractor",  // 実行ファイル名(PATH)または絶対パス
      "args": [],                   // 省略可
      "cwd": null                   // 省略可(相対 command の解釈基準。`go run .` 型のため)
    }
  ]
}
```

- **拡張子 → コマンドの明示宣言**が第一級の情報。発見(どのファイルをどのプラグインに渡すか)
  はこの宣言だけで完結し、**プラグインを spawn せずにルーティングできる**(起動コストゼロ)。
- `command` の解釈: PATH 検索または cwd 起点の相対/絶対パス。`.librarian/` からの相対も許す
  かは Step 3 で確定(セキュリティ上、既定は絶対 or PATH のみ、相対は opt-in が無難)。

### 4.3 優先度(2 軸を分離する)

precedence は**別々の 2 軸**であることを明記する(混同すると設計が壊れる):

- **軸 A: 拡張子 → 抽出器(`index` 内の routing)。** 明示エントリ
  (`.librarian/extractors.json`)が既定エントリ(Go/PHP)より優先。同一ファイル内では
  先頭が勝つ。TS(in-process 既定枠)は明示エントリで上書き可能(escape hatch)だが非推奨。
- **軸 B: native 抽出 vs 外部 `.scip` import(scip-design.md §4.5)。** native が常に勝つ。
  これは `index`(native)と `import`(外部 scip)の間の規則で、**軸 A とは独立**。
  レジストリに登録された拡張子は「native が claim する拡張子」なので、degrade `.scip` の
  該当ドキュメントは従来どおりスキップされる(`skippedNativeFiles`)。

## 5. 却下案: PATH 規約による暗黙発見

比較検討し**却下**する(dlog に `--rejected` で記録)。

**案**: git サブコマンド流に、`librarian-extractor-<ext>`(または `librarian-extractor-rs`)
という名前の実行ファイルを PATH から自動発見して実行する。宣言ファイル不要。

**却下理由**:
1. **暗黙の信頼**: PATH 上の任意実行ファイルを自動発見・実行することになる。プラグイン =
   任意コマンド実行(§7)である以上、「何が実行されるか」は明示・レビュー可能でなければ
   ならない。PATH 汚染が即コード実行になる。
2. **環境差による非決定性**: 同じ repo が別マシンで別のプラグインに解決されうる。librarian の
   決定性(eval 完全一致ゲート・selfindex byte 一致)と正面衝突する。
3. **レビュー可能性**: `.librarian/extractors.json` は repo にコミットされ、PR 差分として
   レビューできる。「このリポジトリはどの言語をどのコマンドで抽出するか」が git 履歴に残る。

明示レジストリはコミット可能・レビュー可能・再現可能。PATH 規約が持ち込む 3 つの問題を
すべて回避する。

## 6. ハンドシェイク — `--capabilities` とバージョン交渉

### 6.1 契約

プラグインは `<command> [args...] --capabilities` で呼ばれたら、**stdin を読まず**に
1 行の JSON を stdout に emit して exit 0 する:

```json
{ "protocol": "librarian-scip-plus", "protocolVersion": 1, "name": "librarian-rust", "extensions": [".rs"] }
```

- `protocol`: 固定文字列 `"librarian-scip-plus"`(封筒契約の識別子)。
- `protocolVersion`: 封筒メジャーバージョン(現行 1)。
- `name` / `extensions`: 自己申告。レジストリ宣言との突き合わせに使う。

### 6.2 交渉規則

- 抽出前に一度だけ `--capabilities` を照会する(結果はプロセス寿命でキャッシュ)。
- ランナーは protocolVersion 1 を話す。プラグインが**自分の話せない major** を申告したら、
  明確なエラーで停止(degrade ではなく fail — 契約不一致は黙って劣化させない)。
- `--capabilities` に**非対応(旧プラグイン)** = 未知フラグを無視して stdin を読もうとする、
  もしくは非 0 exit するプラグインは、**protocolVersion 1 とみなして続行**(後方互換、原則 4)。
  ランナーは capabilities 照会の失敗を致命扱いにしない。
- `extensions` がレジストリ宣言と食い違う場合は**警告**(routing はレジストリ宣言が正 —
  §4.2 の「spawn せず発見」を守るため)。

### 6.3 リファレンスプラグインへの追加

`go-extractor/main.go` と `php-extractor/extract.php` の entry point は現在 stdin を無条件で
読む。先頭で `--capabilities` を検出したら上記 JSON を出して即 return する分岐を足す
(数行)。stdin 読み取りより前に判定するのが不変条件。

## 7. 汎用サブプロセスランナーと信頼モデル

### 7.1 汎用ランナー

`src/extractors/go.ts` / `php.ts` のプラミング(現状ほぼ同一)を 1 つの
`SubprocessExtractor`(`src/extractors/subprocess.ts`)に畳む:

```
class SubprocessExtractor implements Extractor {
  constructor({ name, extensions, resolveCommand })
  extract(rootDir, files):
    cmd = resolveCommand()
    if (!cmd) return fileLevelOnly(rootDir, files)   // 共有の degrade
    capabilities negotiation (§6, 初回のみ)
    spawnSync(cmd, { input: {root, files} on stdin })
    handle spawn error / nonzero exit / stderr passthrough
    reject legacy ExtractionResult[] array contract
    return scipPlusToExtractionResults(parseScipPlus(stdout))
}
```

- `src/extractors/go.ts` / `php.ts` は**リファレンス resolver(コマンド解決ラダー)+ ファクトリ**
  だけに縮む(~30–40 行)。degrade の `fileLevelOnly` / `moduleId` はランナー側に集約。
- `.librarian/extractors.json` のエントリは `resolveCommand = () => ({ cmd, args, cwd })` を
  持つ `SubprocessExtractor` に変換される(同じランナーを通る)。
- **ランナーは `src/extractors/`**(契約の**消費者**)。ワイヤ契約そのもの(封筒型・moniker・
  JSON Schema)は `src/protocol/`(将来 npm 化する公開単位)に住む。この分離を崩さない。

### 7.2 信頼モデル(明文化)

- **プラグイン = 任意コマンドの実行。** librarian はプラグインコマンドを子プロセスとして
  そのまま実行する。サンドボックスしない。
- **明示登録のみ・自動ダウンロード無し。** レジストリに書かれたコマンドしか実行しない。
  ネットワークからのプラグイン取得機構は持たない。
- **レビュー可能性が信頼の基盤。** `.librarian/extractors.json` は repo にコミットされ、
  「このリポジトリは何を実行するか」が PR でレビューでき、git 履歴に残る。
- README / 本文書にこの信頼境界を明記する(利用者が third-party プラグインを登録する = その
  コマンドに repo とマシンを預ける、という理解を促す)。

## 8. 契約の公開物化と conformance

「これだけ読めばプラグインが書ける」単一の参照点を作る(受け入れ条件)。本文書がその束ね:

1. **封筒の JSON Schema** — `src/protocol/scip-plus.schema.json`(新規、Step 1)。`{ scip, ext }`
   封筒と ext スキーマ(scip-design.md §4.4)の機械可読仕様。将来 npm パッケージに同梱する
   公開物。
2. **moniker 文法** — scip-design.md §4.2 が単一の正。実装は `src/protocol/scip.ts`
   (moniker ⇄ id 写像)。本文書はそこへ参照を張るだけ(二重定義しない)。
3. **conformance fixture** — `eval/fixtures/<lang>-taskflow` + `eval/golden/<lang>-taskflow.json`。
   プラグインの適合性 = 「fixture をインデックスして golden 結果セットを再現する」
   (`librarian eval` が conformance ランナーそのもの)。プラグイン作者向けに
   「fixture を用意 → 期待 symbols/edges を golden 化 → eval green」の手順を文書化する。

**新言語プラグインを書く手順**(本文書 + 上記 3 点だけで完結すること、が受け入れ条件):
封筒を emit する → moniker 文法に従う(id は再計算されるので内部ハッシュ不要)→
`--capabilities` を実装 → `.librarian/extractors.json` に登録 → fixture で eval green。

**実世界での実証**は #6(Python を native プラグインとして書く)が理想だが、それは #6 の
スコープ。#22 の最低ラインは**ドキュメントのウォークスルーで確認**(issue の受け入れ条件どおり)。

### 8.1 任意規約: import binding エッジ(cross-repo 解決の opt-in、#27 / ADR-8)

`librarian link` は、リポジトリを跨ぐ呼び出しを**名前一致の推測ではなく binding の事実**で
解決する。そのためにプラグインは、**repo 内に解決できなかった import**(= 外部 package)に
ついて、名前を **package 修飾** で吐ける:

| エッジ | `toName` | 意味 |
| --- | --- | --- |
| `imports`(module から) | `<specifier>` | ファイルがその指定子を import している(既存。必須) |
| `imports`(module から) | `<specifier>#<imported>` | そこから `<imported>` を binding している |
| `imports`(module から) | `<specifier>#<imported> as <local>` | 別名 binding(局所名は `<local>`) |
| `calls` / `extends` / `references` | `<specifier>#<imported>` | **その import を使った参照点**。生の局所名ではなく、由来 package で名付ける |

すべて `resolved = false` / `toId = null`。最後の行が肝で、**参照点そのものが由来を名乗る**ため
link 側は「ファイル内の名前表を引いて突き合わせる」必要がない。結果として、export と同名の
メソッド呼び出し(`seen.add(v)` と import された `add`)は生名 `add` のままなので、
**構造的に繋がりようがない**(偽エッジが作れない)。これらはすべて **repo に依存しない事実**
(「この指定子からこの名前を取った」)なので repo-unaware invariant(#11)を破らない —
package → repo の写像を持つのは store/app 層(`link`)だけ。

**任意**である: 吐かないプラグインは cross-repo 解決が起きないだけで、degrade も偽エッジも
発生しない(link はその言語のエッジに触れない)。現状 TS 抽出器(`importBindings`)が唯一の
実装。link 側は言語を知らないので、同じ規約で吐けば無改造で効く。`link` が繋ぐのは
**module-scope の宣言を名前で import したもの**だけで、メソッド・default/namespace import は
`resolved = 0` のまま残す(型解決が要るため)。

## 9. リファレンスプラグインの再位置付け(README)

`go-extractor/` / `php-extractor/` を「同梱の組み込み実装」から「**プロトコルのリファレンス
プラグイン**」へ再フレームする(README)。第三者が新言語プラグインを書くときにコピーする
2 つの実例(1 つはコンパイル型 = Go、1 つはインタプリタ型 = PHP)。挙動・配布は不変、
位置付けと文書だけ変える。

## 10. ADR 変更提案(architecture.md §5 への追記文面)

> **ADR-7: 抽出器はプロトコル準拠のプラグイン。発見・登録は明示レジストリ、ワイヤ契約は SCIP+ 封筒。**
> 理由: librarian のコア価値は store/retrieval であり、パース・抽出は第三者が差し替え・追加
> できるべき。#16 の SCIP+ 封筒(stdin/stdout の単一 JSON、protobuf 非依存)+ moniker→id の
> 決定的再計算(#16)+ repo-unaware invariant(#11)で、事実上のプラグイン ABI は既に存在する。
> ADR-7 はこれを公開契約に格上げし、(1) 発見・登録を `.librarian/extractors.json`(拡張子→
> コマンドの明示宣言)に集約、(2) 言語別アダプタを 1 つの汎用サブプロセスランナーに畳み、
> (3) `--capabilities` ハンドシェイクで封筒バージョンを交渉する。信頼モデルは**明示登録のみ・
> 自動ダウンロード無し・PATH 規約による暗黙発見を採らない**(暗黙の信頼と環境差の非決定性を
> 排除)。ADR-2 と非衝突(抽出は言語ごと native のまま。プラグイン化は「発見・登録の外部化」で
> あって「TS Compiler API を捨てる」ことではない — TS は in-process 実装のまま特別扱い)。
> ADR-6 と非衝突(ワイヤ契約は SCIP+ 封筒そのもの。プロトコルはその発見・実行規約を足すだけ)。
> ADR-1 と非衝突(保存先は SQLite のまま)。
> トレードオフ: 公開契約はバージョニングとの後方互換コミットメント(封筒スキーマは追加のみ、
> major は `--capabilities` で交渉)。プラグイン = 任意コマンド実行の信頼境界を利用者に開く。
> 既存 Go/PHP はレジストリ経由で動き eval 完全一致(#16 と同じゲート)。

※ 補足: ADR-6(SCIP+)は scip-design.md §7 に追記文面がありながら architecture.md §5 へ
未反映だった(#16 の積み残し)。ADR-7 の非衝突議論が ADR-6 を参照するため、本 issue で
ADR-6 も併せて §5 へ取り込んだ(Step 5)。

## 11. 段階計画(eval 完全一致ゲート)

| Step | 内容 | 完了条件 | 状態 |
|---|---|---|---|
| 0 | **本文書 + ADR-7 の合意**(architecture.md §9 の手続き) | レビュー済み・dlog 記録 | ✅ |
| 1 | `--capabilities` ハンドシェイクを両リファレンスプラグインに追加 + `protocolVersion` 定数 + `src/protocol/scip-plus.schema.json` | capabilities 統合テスト(go/php)+ `parseCapabilities` 単体テスト green・eval 不変 | ✅ |
| 2 | 汎用 `SubprocessExtractor` ランナー(`src/extractors/subprocess.ts`)。go.ts/php.ts をランナー利用に refactor | **eval 完全一致**(go 95.7% / php 88.1% / python 88.1% が byte 単位一致) | ✅ |
| 3 | `.librarian/extractors.json` の読み込み・マージ・上書き(`src/app/registry.ts`)+ 信頼モデル(明示のみ) | Go をレジストリエントリ経由で駆動して 45/47・0.957 再現。第三者 echo プラグインで end-to-end 実証。go/php/python eval 完全一致 | ✅ |
| 4 | 契約文書の確定(JSON Schema/moniker/conformance の束ね)+ README のリファレンスプラグイン再位置付け | 新言語プラグインの手順が本文書 §8 のウォークスルーで完結 | ✅ |
| 5 | selfindex 再生成 + ADR-7(と ADR-6)の architecture.md §5 反映 | `npm run selfindex` 再生成・ドキュメント | ✅ |

- 各ステップは #16 と同じ回帰ゲート(eval 完全一致 / selfindex byte 一致)を通してから次へ。
- Step 3 の第三者プラグイン実証は「任意言語の最小 echo プラグイン(封筒を固定で返す)」で
  レジストリ経路が動くことを示せば足りる(実言語追加は #6/#9 のスコープ)。

## 12. リスクと実装時の検証事項

1. **capabilities 照会の後方互換**: 旧プラグイン(`--capabilities` 非対応)を壊さないこと。
   照会失敗 = protocolVersion 1 とみなす分岐を Step 1 のテストで固定する。
2. **eval 完全一致の担保**: Step 2 のランナー畳み込みは pure refactor。go/php/python の
   baseline と selfindex の byte 一致を両方確認(#16 Step 2–3 と同じ規律)。
3. **レジストリの決定性**: マージ順・上書き規則(§4.3 軸 A)を決定的に。同一拡張子の重複
   宣言は先頭勝ち + 警告。並列抽出でも安定(順序は宣言順で固定)。
4. **信頼境界の明示**: 第三者プラグイン登録 = 任意コマンド実行。README/文書での明文化が
   セキュリティ設計の実体(サンドボックスはしない)。
5. **`.librarian/` の役割拡張**: 現在 committed self-index(MAP.md / self.db)の置き場。
   `extractors.json` を足すことで「librarian のリポジトリ単位設定」の器になる。self-index
   生成物と設定ファイルの混在に注意(gitignore/コミット方針を Step 3 で確定)。
