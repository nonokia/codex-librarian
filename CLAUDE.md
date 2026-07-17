# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Codex Librarian** — コードベースの「理解負債」を返済する AI レビュー & 知識資産化プラットフォーム。
`docs/architecture.md` が **WHY/WHAT の source of truth**。原則・ADR(§5)に反する設計はしない。
反する必要が生じた場合は実装せず ADR 変更提案として返すこと(§9)。

- **Graph-first**: レビュー/検索の単位は diff ではなく「diff が触れたコードグラフ上の近傍」。
- **単一 SQLite・ローカル完結**(ADR-1)。運用ミドルウェアを持たない。
- **抽出器は TypeScript Compiler API**(ADR-2)。tree-sitter ではない。`allowJs` で JS/JSX も対象。
  Go は ADR-2 の多言語パス: `go-extractor/`(`go/packages` = 公式型チェッカベースの
  Go 製バイナリ)を子プロセスとして呼ぶ(issue #7、`docs/go-baseline.md`)。
  PHP も同じ多言語パス: `php-extractor/`(nikic/php-parser + NameResolver、パーサ同梱の
  PHP スクリプト)を子プロセスとして呼ぶ(issue #8、`docs/php-baseline.md`)。
  Python も同じ多言語パス: `py-extractor/`(標準ライブラリ `ast` のみ・依存ゼロの Python
  スクリプト)を子プロセスとして呼ぶ(issue #9 ではなく issue #6、`docs/python-baseline.md`)。
  Python には標準の型チェッカが無いため、ADR-2 の「型解決必須」への答えは**型推論器を積むこと
  ではなく、静的な名前解決(import グラフ / MRO / `__init__` 属性型 / override エッジ)を書き、
  解けないものを resolved=0 で残すこと**(dlog 記録)。外部 scip-python の取り込み口
  (`import --prefer-scip`)は degrade 経路として残る。
  Terraform (HCL) も同じ多言語パス: `tf-extractor/`(hashicorp/hcl、Go 製バイナリ)を
  子プロセスとして呼ぶ(issue #9、`docs/terraform-baseline.md`)。ただし HCL は
  call graph でなく**参照グラフ**で、型解決が要らず構文レベルで十分 — ADR-2 の「型解決
  必須」は call graph 言語向けの判断であり HCL には適用しない(dlog 記録)。
  SQL も同じ多言語パス・同じ参照グラフの整理: `sql-extractor/`(libpg_query =
  PostgreSQL 本体のパーサ、pganalyze/pg_query_go 経由の Go 製バイナリ)を子プロセスと
  して呼ぶ(issue #36、`docs/sql-baseline.md`)。方言は Postgres のみで `--capabilities`
  の `dialect` に申告、他方言はパース失敗としてファイルレベルに degrade(偽エッジより
  欠落)。function/procedure 本体は sql_body / LANGUAGE sql / plpgsql の 3 段階で
  best-effort に辿る(dlog 記録)。
- **全機能はまず CLI**(`librarian`)として存在する。

## Commands

```bash
npm install          # 依存インストール
npm run build        # tsc で dist/ へビルド
npm test             # node --test によるユニットテスト
node dist/cli.js --help          # ビルド後の CLI
librarian index <repo>           # リポジトリをインデックス
librarian stats                  # ストア統計
librarian map [--json]           # 決定的コードベースマップ(markdown)
librarian graph <symbol>         # k-hop 近傍探索
librarian eval <golden.json>     # retrieval match 率の計測(ADR-4)
librarian link [--map f] [--clear]   # repo 間 import 解決(明示宣言、ADR-8)
librarian resolve-dispatches [--clear]   # フレームワーク規約ディスパッチ解決(命名規約、ADR-9)
librarian pack <diff>            # 区画付き Context Pack(markdown)
librarian review <diff> --markdown   # Claude API でレビュー生成(要 ANTHROPIC_API_KEY)
librarian learn <golden.json> --holdout  # 戦略掃引 → PatternCache 昇格(§4-⑤)
librarian history                # 精度の時系列(ADR-4)
librarian feedback <id> --good   # 人間の 👍/👎 を retrieval_log へ

# Web UI (Phase 3) — 親の dist/ を参照するため root の npm run build が先
cd web && npm install
LIBRARIAN_DB=/path/to/idx.db npm run dev   # http://localhost:3000
```

## Self-index first (required — issue #15)

このリポジトリは **自分自身の committed self-index** を持つ(dogfooding)。
**コードを変更する前に、全ファイルを読む代わりに committed self-index を引くこと** —
dlog の「変更前に `dlog why`」と対になるルール:

1. まず `.librarian/MAP.md` を grep(ファイル→シンボル、imports、シンボル間 edges、
   unresolved 集計が決定的な形式で載っている)。
2. 深掘りは `librarian graph <symbol> --db .librarian/self.db` /
   `librarian pack <diff> --db .librarian/self.db`(近傍だけ読めば着手できる)。
3. `src/` または `web/` を変更したら、コミット後に `npm run selfindex` で再生成し、
   `.librarian/self.db` + `.librarian/MAP.md` を**次のコミット**で取り込む
   (dlog db と同じ 1 コミット遅れ)。stale 検出は `npm run selfindex:check`
   (再生成した map との diff。差分ありなら exit 1)。
4. 注意: `pack`/`review` は retrieval_log を self.db に**書き込む**。残す意図が
   なければ `git checkout .librarian/self.db` で戻す(graph/symbols/file/map/stats
   は読み取り専用)。

## Decision logging with dlog (required)

このリポジトリでは **すべての実装判断を [dlog](https://github.com/nonokia/dlog) に記録する**。
使い方の詳細は `AGENTS.md` を参照。運用ルール:

1. セッション開始時に `dlog status` で staging の残骸を確認する。identity は record の
   たびに `--agent-role` / `--agent-model` フラグで渡す(dlog 0.2.0。export は不要 —
   tool 呼び出しの shell は毎回リセットされるため env はあてにならない)。
2. 設計判断をした瞬間に `dlog record --rationale ... --file <anchor>` する
   (却下した代替案は `--rejected "approach :: reason"`、制約は `--declares-invariant`)。
3. コミットは `dlog commit -m "..."` を使う(git commit 後に staged decisions を自動 seal)。
4. **`.dlog/dlog.db` はリポジトリにコミットする**(このプロジェクトの実験目的:
   意思決定ログをコードと一緒に持ち運ぶ)。seal はコミット後に db を書き換えるため、
   db ファイル自体は次のコミットで取り込まれる(1 コミット遅れで追従)。
5. コードを変更する前に `dlog why <file>` / `dlog context <path>` で過去の決定を確認する。

## Layout

`src/` はレイヤ構造(依存 DAG の物理化、issue #21)。詳細とレイヤ図は `src/README.md`。

- `docs/architecture.md` — アーキテクチャ設計書(WHY/WHAT)。フェーズ計画・ADR・成功指標。
- `docs/phase0-report.md` — Phase 0 ベースライン計測と失敗分析。**retrieval を変更したら
  必ず `librarian eval` を回して数値を更新すること(ADR-4)。**
- `docs/scip-design.md` — SCIP+ 設計(issue #16 / ADR-6)。抽出器⇄store の交換
  フォーマット。**ext サイドカーが retrieval 信号の正、ベース SCIP は標準準拠の投影。**
- `docs/plugin-protocol.md` — 抽出器プラグインプロトコル設計(issue #22 / ADR-7)。SCIP+ 契約の
  公開・レジストリ化。封筒 JSON Schema・moniker 文法・conformance の束ね(living reference)。
- `src/store/store.ts` — Knowledge Store(`node:sqlite`)。files/symbols/edges + 再帰 CTE。
- `src/protocol/extractor.ts` — Extractor インターフェース(多言語対応の抽象、公開面)。実装は
  TS(`src/extractors/ts.ts`、in-process)・Go(`src/extractors/go.ts` + `go-extractor/`)・PHP
  (`src/extractors/php.ts` + `php-extractor/`)・Python(`src/extractors/python.ts` +
  `py-extractor/`)・Terraform(`src/extractors/terraform.ts` + `tf-extractor/`)・SQL
  (`src/extractors/sql.ts` + `sql-extractor/`)。
  Go/PHP/Python/Terraform/SQL は汎用ランナー
  `src/extractors/subprocess.ts` に resolver を渡すリファレンスプラグイン。
- `src/protocol/scip-plus.schema.json` — 封筒(`{scip, ext}`)の JSON Schema(プラグイン公開物)。
- `src/app/registry.ts` — 抽出器レジストリ(issue #22)。ビルトイン(TS/Go/PHP/Python/Terraform/SQL)
  + `.librarian/extractors.json` の合成・拡張子上書き(`resolveExtractors`)。信頼モデル:
  明示登録のみ・自動 DL/PATH 規約発見なし。
- `go-extractor/` — Go 抽出バイナリ(`golang.org/x/tools/go/packages`)。stdin/stdout
  JSON 契約 + `--capabilities`。ビルド・配布は README の「Go リポジトリのインデックス」。
- `tf-extractor/` — Terraform (HCL) 抽出バイナリ(hashicorp/hcl)。参照グラフ(call graph
  ではない)。SCIP+ 封筒 + `--capabilities`。symbol は参照アドレスで命名(`aws_x.y` /
  `var.z` / `module.m` / `data.t.n` / `local.k` / `output.o`)。ビルド・配布は README の
  「Terraform リポジトリのインデックス」、ベースラインは `docs/terraform-baseline.md`。
- `sql-extractor/` — SQL 抽出バイナリ(libpg_query / pg_query_go、Postgres 方言のみ)。
  参照グラフ。SCIP+ 封筒 + `--capabilities`(`dialect: postgresql` を申告)。symbol は
  参照アドレスで命名(`table.users` / `view.v` / `matview.m` / `function.f` /
  `procedure.p` / `trigger.tr` / `index.i`)。FK / FROM / JOIN / EXECUTE FUNCTION が
  references エッジ、関数本体は sql_body / LANGUAGE sql / plpgsql の 3 段階 best-effort。
  ビルド・配布は README の「SQL リポジトリのインデックス」、ベースラインは
  `docs/sql-baseline.md`。
- `php-extractor/` — PHP 抽出スクリプト(nikic/php-parser、`vendor/` 同梱)。stdin/stdout
  JSON 契約 + `--capabilities`。インタプリタ実行でビルド不要 — 詳細は README の「PHP リポジトリのインデックス」。
- `py-extractor/` — Python 抽出スクリプト(標準ライブラリ `ast` のみ、依存ゼロ・ビルド不要)。
  SCIP+ 封筒 + `--capabilities`。名前解決は自前(import グラフ / MRO / `__init__` 属性型 /
  override エッジ)。ベースラインは `docs/python-baseline.md`(native 95.2% vs 外部
  scip-python 取り込み 88.1%、同一 golden)。
- `src/protocol/scip.ts` — SCIP+ 境界(封筒/ext 型、`.scip` の protobuf encode/decode、Symbol
  文法パーサ、moniker⇄id 写像)。protobuf はこのファイルの外に出さない。
- `src/protocol/scip-ingest.ts` — SCIP+ 封筒 → ExtractionResult 写像(native 経路。エッジは
  ext が正)。
- `src/protocol/scip-emit.ts` — ExtractionResult → SCIP+ 封筒の汎用 emit(TS in-process 経路 +
  `export --scip`)。**3 言語すべて SCIP+ 契約済み**(issue #16 Step 2–3)。
- `src/protocol/scip-export.ts` — store → SCIP+ の export(`librarian export --scip`、issue #16
  Step 4)。
- `src/app/index.ts` — 抽出器ディスパッチ(旧 indexer.ts の dispatch 部、issue #21 で分離)。
  ファイル発見・拡張子ルーティング・`indexRepo`/`importScip`。
- `eval/fixtures/go-taskflow/` — Go 用正解セットの対象リポジトリ(コミットされた fixture)。
  ベースラインは `docs/go-baseline.md`(`eval/golden/go-taskflow.json`)。
- `eval/fixtures/php-taskflow/` — PHP 用正解セットの対象リポジトリ(コミットされた fixture)。
  ベースラインは `docs/php-baseline.md`(`eval/golden/php-taskflow.json`)。
- `eval/fixtures/python-taskflow/` — Python 用正解セットの対象リポジトリ(コミットされた
  fixture)。**同じ golden(`eval/golden/python-taskflow.json`)を native 抽出器
  (`docs/python-baseline.md`)と外部 scip-python 取り込み(`docs/scip-baseline.md`、
  同梱の `index.scip`)の両方で使う** — 唯一の A/B 比較ができる言語。
- `eval/fixtures/terraform-taskflow/` — Terraform 用正解セットの対象構成(コミットされた
  fixture、ローカル module 含む)。ベースラインは `docs/terraform-baseline.md`
  (`eval/golden/terraform-taskflow.json`)。
- `eval/fixtures/sql-taskflow/` — SQL 用正解セットの対象スキーマ(コミットされた fixture。
  schema/ + views + functions + migrations)。ベースラインは `docs/sql-baseline.md`
  (`eval/golden/sql-taskflow.json`)。
- `src/app/link.ts` — リポジトリ間 import 解決(issue #27 / ADR-8)。`.librarian/links.json`
  の **明示宣言(package → repo)** を入力に、抽出器が残した unresolved エッジを再解決する
  後段ステップ(`librarian link`)。**推測で名前一致させない** — 抽出器が吐く import
  binding エッジ(`imports <spec>#<imported>`、`docs/plugin-protocol.md` §8.1、TS/Go/Python/PHP
  の 4 言語が実装、#27/#35)を辿って束縛し、曖昧なら繋がない。`forSpec()` の subpath 区切りは
  エコシステム毎(`/`・`.`・`\`)。冪等・可逆(`--clear`)。宣言が無い db では cross-repo エッジは
  0 本で #27 以前と同一。数値は `docs/cross-repo-baseline.md`(TS link なし 0.429 → あり 1.000、
  Python 0.462 → 1.000)。
- `src/app/resolve-dispatches.ts` — フレームワーク規約の動的ディスパッチ解決(issue #43 / ADR-9)。
  抽出器が `resolved=0` で残した `dispatches` エッジ(`dispatch <controller>#<action>`)を、CakePHP の
  命名規約(`<name>Controller` + 同名 public メソッド)で束縛する後段ステップ(`librarian
  resolve-dispatches`)。**推測ではなく規約** — 対象が無ければ unresolved のまま、同名 controller が
  複数なら繋がず拒否。冪等・可逆(`--clear`)・dry-run 可。検出は `php-extractor/extract.php`
  (redirect/setAction、リテラル文字列のみ)。数値は `docs/dispatch-baseline.md`(resolve なし 0.273 →
  あり 1.000)。エッジ種別 `dispatches` と契約は `docs/plugin-protocol.md` §8.2。
- `eval/fixtures/cake-taskflow/` — CakePHP 形の fixture(issue #43)。redirect/setAction で画面遷移する
  controllers。golden は `eval/golden/cake-taskflow.json`(4 ケース、resolve なし 3/11 → あり 11/11)。
- `eval/fixtures/cross-repo/` — 相互参照する fixture ペア(`acme-core` = package `@acme/core`
  と、それを package 名で import する `acme-app`)。golden は `eval/golden/cross-repo.json`。
- `eval/fixtures/cross-repo-py/` — 非 TS の cross-repo ペア(#35。`pycore` = package `taskcore`
  と、それを import する `pyapp`)。TS を含まない index で link が効くことの eval 実証。
  golden は `eval/golden/cross-repo-py.json`(link なし 6/13 → あり 13/13)。多言語の回帰は
  `src/test/cross-repo-multilang.test.ts`(Python fixture + Go/PHP inline)。
- `src/core/diff.ts` / `src/core/retrieval.ts` — unified diff → シード → 決定的展開(ADR-3
  stage 1)。
- `src/app/eval.ts` + `eval/golden/` — Phase 0 評価ハーネスと正解セット(規律は
  `eval/README.md`)。
- `src/app/loop.ts` — 自己改善ループ(§4-⑤): 戦略候補・learn 掃引・レビュー結果の還流。
  数値は `docs/phase4-report.md`(train=test と holdout の区別に注意)。
- `src/core/contextpack.ts` — Context Pack 組み立て(§4-③ の区画: 変更/呼び出し元/呼び出し先/
  テスト)。
- `src/app/review.ts` — LLM でのレビュー生成(構造化出力)。プロバイダは `src/llm/` の
  registry が解決(ADR-10)。モデル既定は `claude-opus-4-8`(anthropic プロバイダ)。
- `src/llm/` — LLM プロバイダ抽象(issue #42 / ADR-10)。`provider.ts`(`LlmProvider` 抽象 +
  型付きエラー)、`registry.ts`(`LLM_PROVIDER` env で `anthropic`(既定)/
  `openai-compatible` を明示選択 — 暗黙フォールバックなし、ADR-7 と同じ信頼モデル)、
  `providers/`(ビルトイン 2 実装)。プロバイダ名を知るのはここだけ —
  `src/core`/`src/app`/`web/app` は抽象のみ扱う(不変条件)。モデルは `--model` >
  `LLM_MODEL` > `LIBRARIAN_MODEL`(後方互換)> プロバイダ既定。env 契約は README
  「LLM プロバイダの選択」。
- `templates/librarian-review.yml` — 対象リポジトリに配る GitHub Actions テンプレート(§4-④)。
- `web/` — Phase 3 の Web UI(Next.js、ADR-5)。蔵書目録(ダッシュボード)/ 書架を歩く
  (グラフ可視化)/ 司書に聞く(グラフ近傍 Q&A、要 ANTHROPIC_API_KEY)。store へは
  親 dist/ 経由の読み取りのみで、ロジックの再実装はしない。
- `src/cli.ts` — CLI エントリポイント(据え置き、`dist/cli.js` 不変)。
- `src/core/map.ts` — `librarian map` のマップ組み立て/レンダラ(決定性が不変条件)。
- `scripts/selfindex.mjs` — 自己インデックスの再生成と drift 検出(`npm run selfindex[:check]`)。
- `.librarian/MAP.md` / `.librarian/self.db` — committed self-index(コミット対象、issue #15)。
  「Self-index first」参照。
- `.dlog/dlog.db` — dlog の意思決定ログ(コミット対象)。
