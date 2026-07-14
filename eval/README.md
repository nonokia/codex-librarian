# eval — Phase 0 評価ハーネスの正解セット

`librarian eval <golden.json>` が読む正解セット置き場。フォーマット(`src/eval.ts` の
`GoldenCase`):

```jsonc
{
  "cases": [
    {
      "id": "wyt-001",
      "title": "何を変更するシナリオか",
      "note": "出典(実コミット sha 等)",
      // どちらか一方:
      "target": { "file": "src/x.js", "symbol": "fn" },  // 現インデックスの span から
                                                          // ハンクを合成(行ズレに強い)
      "diff": "unified diff テキスト",                    // 実 PR 形式そのまま
      "expected": [
        { "file": "src/y.js", "symbol": "caller" },  // symbol 省略時はファイル一致で可
        { "file": "src/y.test.js" }
      ]
      // マルチレポの db では target / expected に "repo": "<name>" を足せる(#11/#27)。
      // target.repo はシードの探索範囲も絞る(同じパスが複数 repo にある場合に必要)。
    }
  ]
}
```

キュレーションの規律:

- **expected はリトリーバを見ずに書く**(コードリーディング+実コミットの根拠で)。
  現行実装に取れないエントリを削らない — その差分が改善対象そのもの。
- シード(diff 自身に含まれるシンボル)は当たりに数えられないので expected に入れない。
- 数値の解釈と現在のベースラインは `docs/phase0-report.md`。

正解セットと、それが必要とする索引の状態:

| golden | 対象 | 前提 |
| --- | --- | --- |
| `weather-you-travel.json` | 外部 TS/JSX リポジトリ(Phase-0) | `index` のみ |
| `<lang>-taskflow.json` | `eval/fixtures/<lang>-taskflow` | `index` のみ |
| `cross-repo.json` | `eval/fixtures/cross-repo`(2 repos) | 両 repo を `index` した後に **`librarian link`**。link 前は 6/14(repo 内近傍のみ)、link 後は 14/14 — その差が #27 の測定対象そのもの(`docs/cross-repo-baseline.md`) |
