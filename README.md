# code-on-board — Codex Librarian

Personal experiment to reverse-engineer the concept of Nexon's CodeOnBoard (NDC26),
re-designed for individual-developer scale. コードベースの「理解負債」を返済する
graph-first な AI レビュー & 知識資産化プラットフォーム。

- **設計書(source of truth): [`docs/architecture.md`](docs/architecture.md)** — 原則・ADR・フェーズ計画
- **検証レポート: [`docs/validation-weather-you-travel.md`](docs/validation-weather-you-travel.md)**
- 意思決定ログ: [`dlog`](https://github.com/nonokia/dlog) で記録し、`.dlog/dlog.db` をコミットしている。
  `dlog why src/indexer.ts` などで「なぜこうなっているか」を照会できる(運用ルールは `AGENTS.md` / `CLAUDE.md`)。

## Status

- **Phase 0 実装済み**: 評価ハーネス(`librarian eval`)+ 正解セット 16 ケース
  (weather-you-travel 由来)。ベースライン **micro recall 69.6%** —
  詳細と失敗分析は [`docs/phase0-report.md`](docs/phase0-report.md)。
- **Phase 1 スライス実装済み**: TypeScript Compiler API による型解決済み symbols/edges
  抽出(ADR-2)、単一 SQLite の Knowledge Store + 再帰 CTE k-hop 探索(ADR-1)、
  決定的展開リトリーバ(`librarian retrieve`、ADR-3 の stage 1)。
- **Phase 2 実装済み(MVP)**: 区画付き Context Pack 組み立て(`librarian pack`)、
  Claude API による文脈接地レビュー生成(`librarian review`、構造化出力 + findings ごとの
  根拠セクション記録)、GitHub Actions テンプレート(`templates/librarian-review.yml`)。
- **Phase 4 実装済み**: RetrievalLog + diff シグネチャ → 戦略の PatternCache +
  戦略探索(`librarian learn`)。micro recall 69.6% →(チューニング)87.0% →
  (PatternCache)**89.1%**。ただし holdout では改善が示せておらず、汎化の主張には
  正解セットの成長が先 — 詳細は [`docs/phase4-report.md`](docs/phase4-report.md)。
- **Phase 3 実装済み**: Web UI(`web/`、Next.js)—「図書館」体験のデモ。
  蔵書目録(統計 + 精度時系列 + PatternCache + retrieval_log)、書架を歩く
  (シンボル検索 → k-hop 近傍のグラフ可視化 + ソース閲覧)、司書に聞く
  (グラフ近傍を文脈にした Q&A、要 ANTHROPIC_API_KEY)。

  ```bash
  npm run build                       # 先に root で(web は dist/ を参照)
  cd web && npm install
  LIBRARIAN_DB=/path/to/idx.db npm run dev   # http://localhost:3000
  ```
- 意味的補完(embeddings)は未着手 — ask は語彙一致 + グラフ近傍で動く(UI に明記)。
- **Go 対応実装済み(issue #7)**: `go-extractor/`(`golang.org/x/tools/go/packages`
  ベースの抽出バイナリ)を子プロセスとして呼ぶ第 2 の Extractor。正解セット 12 ケース、
  fixture ベースライン micro recall 95.7% — 詳細は [`docs/go-baseline.md`](docs/go-baseline.md)。

## Go リポジトリのインデックス

`.go` ファイルは Go 製の抽出バイナリ(`go-extractor/`)で symbols/edges 化される。
librarian は以下の順でバイナリを探す:

1. `LIBRARIAN_GO_EXTRACTOR` 環境変数(ビルド済みバイナリへのパス)
2. `librarian-go-extractor` が `$PATH` 上にある(推奨: `go install ./go-extractor` 後、
   `mv $(go env GOPATH)/bin/go-extractor $(go env GOPATH)/bin/librarian-go-extractor`
   か `go build -o <PATHの通った場所>/librarian-go-extractor ./go-extractor`)
3. Go toolchain(1.24+)があれば `go run ./go-extractor` に自動フォールバック(初回は
   ビルドの分だけ遅い)

どれも無い場合、`.go` ファイルはファイルレベルの module シンボルのみに degrade する
(インデックス全体は失敗しない。警告が stderr に出る)。制約: 対象リポジトリは
ルートに `go.mod` を持つこと(非モジュール/ネストモジュールはファイルレベルに degrade)。

## Quick start

```bash
npm install && npm run build
node bin/librarian.js index <repo>        # インデックス(<repo>/.librarian/index.db)
node bin/librarian.js stats --db <db>
node bin/librarian.js graph <symbol> --db <db> --hops 2 --pretty
node bin/librarian.js retrieve <diff-file> --db <db> --budget 8000   # 文脈束
node bin/librarian.js eval eval/golden/weather-you-travel.json --db <db> --pretty
```
