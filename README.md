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
- 意味的補完(embeddings、Phase 3 の Web UI)は未着手。

## Quick start

```bash
npm install && npm run build
node bin/librarian.js index <repo>        # インデックス(<repo>/.librarian/index.db)
node bin/librarian.js stats --db <db>
node bin/librarian.js graph <symbol> --db <db> --hops 2 --pretty
node bin/librarian.js retrieve <diff-file> --db <db> --budget 8000   # 文脈束
node bin/librarian.js eval eval/golden/weather-you-travel.json --db <db> --pretty
```
