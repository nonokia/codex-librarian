# code-on-board — Codex Librarian

Personal experiment to reverse-engineer the concept of Nexon's CodeOnBoard (NDC26),
re-designed for individual-developer scale. コードベースの「理解負債」を返済する
graph-first な AI レビュー & 知識資産化プラットフォーム。

- **設計書(source of truth): [`docs/architecture.md`](docs/architecture.md)** — 原則・ADR・フェーズ計画
- **検証レポート: [`docs/validation-weather-you-travel.md`](docs/validation-weather-you-travel.md)**
- 意思決定ログ: [`dlog`](https://github.com/nonokia/dlog) で記録し、`.dlog/dlog.db` をコミットしている。
  `dlog why src/indexer.ts` などで「なぜこうなっているか」を照会できる(運用ルールは `AGENTS.md` / `CLAUDE.md`)。

## Status

Phase-1 スライス実装済み: TypeScript Compiler API による型解決済み symbols/edges 抽出(ADR-2)、
単一 SQLite の Knowledge Store + 再帰 CTE k-hop 探索(ADR-1)、`librarian` CLI。
評価ハーネス(Phase 0)・Context Engine(Phase 2)は未着手。

## Quick start

```bash
npm install && npm run build
node bin/librarian.js index <repo>        # インデックス(<repo>/.librarian/index.db)
node bin/librarian.js stats --db <db>
node bin/librarian.js graph <symbol> --db <db> --hops 2 --pretty
```
