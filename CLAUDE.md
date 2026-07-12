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

1. セッション開始時に identity を export し、`dlog status` で staging の残骸を確認する。
2. 設計判断をした瞬間に `dlog record --rationale ... --file <anchor>` する
   (却下した代替案は `--rejected "approach :: reason"`、制約は `--declares-invariant`)。
3. コミットは `dlog commit -m "..."` を使う(git commit 後に staged decisions を自動 seal)。
4. **`.dlog/dlog.db` はリポジトリにコミットする**(このプロジェクトの実験目的:
   意思決定ログをコードと一緒に持ち運ぶ)。seal はコミット後に db を書き換えるため、
   db ファイル自体は次のコミットで取り込まれる(1 コミット遅れで追従)。
5. コードを変更する前に `dlog why <file>` / `dlog context <path>` で過去の決定を確認する。

## Layout

- `docs/architecture.md` — アーキテクチャ設計書(WHY/WHAT)。フェーズ計画・ADR・成功指標。
- `docs/phase0-report.md` — Phase 0 ベースライン計測と失敗分析。**retrieval を変更したら
  必ず `librarian eval` を回して数値を更新すること(ADR-4)。**
- `docs/scip-design.md` — SCIP+ 設計(issue #16 / ADR-6 提案)。抽出器⇄store の交換
  フォーマット。**ext サイドカーが retrieval 信号の正、ベース SCIP は標準準拠の投影。**
- `src/store.ts` — Knowledge Store(`node:sqlite`)。files/symbols/edges + 再帰 CTE。
- `src/indexer.ts` — Indexer。TS Compiler API で symbols/edges を抽出。
- `src/extractor.ts` — Extractor インターフェース(多言語対応の抽象)。実装は TS
  (`src/indexer.ts`)・Go(`src/extractor-go.ts` + `go-extractor/`)・PHP
  (`src/extractor-php.ts` + `php-extractor/`)。
- `go-extractor/` — Go 抽出バイナリ(`golang.org/x/tools/go/packages`)。stdin/stdout
  JSON 契約。ビルド・配布は README の「Go リポジトリのインデックス」。
- `php-extractor/` — PHP 抽出スクリプト(nikic/php-parser、`vendor/` 同梱)。stdin/stdout
  JSON 契約。インタプリタ実行でビルド不要 — 詳細は README の「PHP リポジトリのインデックス」。
- `src/scip.ts` — SCIP+ 境界(封筒/ext 型、`.scip` の protobuf encode/decode、Symbol 文法
  パーサ、moniker⇄id 写像)。protobuf はこのファイルの外に出さない。
- `src/scip-ingest.ts` — SCIP+ 封筒 → ExtractionResult 写像(native 経路。エッジは ext が正)。
  Go は SCIP+ emit 済み(issue #16 Step 2)、PHP/TS は旧 ExtractionResult 契約のまま(Step 3)。
- `eval/fixtures/go-taskflow/` — Go 用正解セットの対象リポジトリ(コミットされた fixture)。
  ベースラインは `docs/go-baseline.md`(`eval/golden/go-taskflow.json`)。
- `eval/fixtures/php-taskflow/` — PHP 用正解セットの対象リポジトリ(コミットされた fixture)。
  ベースラインは `docs/php-baseline.md`(`eval/golden/php-taskflow.json`)。
- `src/diff.ts` / `src/retrieval.ts` — unified diff → シード → 決定的展開(ADR-3 stage 1)。
- `src/eval.ts` + `eval/golden/` — Phase 0 評価ハーネスと正解セット(規律は `eval/README.md`)。
- `src/loop.ts` — 自己改善ループ(§4-⑤): 戦略候補・learn 掃引・レビュー結果の還流。
  数値は `docs/phase4-report.md`(train=test と holdout の区別に注意)。
- `src/contextpack.ts` — Context Pack 組み立て(§4-③ の区画: 変更/呼び出し元/呼び出し先/テスト)。
- `src/review.ts` — Claude API でのレビュー生成(構造化出力)。モデル既定は `claude-opus-4-8`。
- `templates/librarian-review.yml` — 対象リポジトリに配る GitHub Actions テンプレート(§4-④)。
- `web/` — Phase 3 の Web UI(Next.js、ADR-5)。蔵書目録(ダッシュボード)/ 書架を歩く
  (グラフ可視化)/ 司書に聞く(グラフ近傍 Q&A、要 ANTHROPIC_API_KEY)。store へは
  親 dist/ 経由の読み取りのみで、ロジックの再実装はしない。
- `src/cli.ts` — CLI エントリポイント。
- `src/map.ts` — `librarian map` のマップ組み立て/レンダラ(決定性が不変条件)。
- `scripts/selfindex.mjs` — 自己インデックスの再生成と drift 検出(`npm run selfindex[:check]`)。
- `.librarian/MAP.md` / `.librarian/self.db` — committed self-index(コミット対象、issue #15)。
  「Self-index first」参照。
- `.dlog/dlog.db` — dlog の意思決定ログ(コミット対象)。
