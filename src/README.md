# src/ レイヤ構造

依存は一方向 DAG(循環なし、self-index の Imports 集計で検証可能):

```
protocol/  →  extractors/  →  app/  →  cli.ts
   ↓                            ↑
store/  ←──── core/ ───────────┘
```

- **protocol/** — 抽出器⇄store の交換契約(公開面)。`extractor.ts`(Extractor
  インターフェース、symbolId)+ SCIP+ 一式(`scip.ts` / `scip-ingest.ts` /
  `scip-emit.ts` / `scip-export.ts`)。抽出器プラグイン化(issue #22 / ADR-7)を
  見据え、将来のプラグイン ABI がここに住む。
- **extractors/** — 言語別の Extractor 実装。`ts.ts`(TypeScript Compiler API、
  in-process)、`go.ts` / `php.ts`(子プロセスアダプタ、`go-extractor/` /
  `php-extractor/` を起動)。
- **core/** — 決定的ロジック。LLM にも子プロセスにも触らない。`diff.ts` /
  `retrieval.ts` / `contextpack.ts` / `map.ts`。
- **store/** — `store.ts`(SQLite、`node:sqlite`)。
- **app/** — ディスパッチと外側のオーケストレーション。`index.ts`(旧
  indexer.ts の dispatch 部 — ファイル発見・拡張子ルーティング・
  `indexRepo`/`importScip`)、`review.ts`(Claude API)、`eval.ts`(ADR-4
  評価ハーネス)、`loop.ts`(自己改善ループ)。
- **cli.ts** — エントリポイント(`dist/cli.js` は不変)。

## 意図的逸脱

`core/retrieval.ts` は `store/store.ts` に直接依存する(k-hop 展開の一部が
再帰 CTE として SQL 側に住む — ADR-1 の意図的な帰結)。クリーンアーキテクチャの
依存性ルールを期待する読者には嘘になるが、単一 SQLite・ローカル完結の原則の上で
不要な Repository 抽象を足すよりこちらを選んでいる(issue #21 の設計討議)。
