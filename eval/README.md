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
    }
  ]
}
```

キュレーションの規律:

- **expected はリトリーバを見ずに書く**(コードリーディング+実コミットの根拠で)。
  現行実装に取れないエントリを削らない — その差分が改善対象そのもの。
- シード(diff 自身に含まれるシンボル)は当たりに数えられないので expected に入れない。
- 数値の解釈と現在のベースラインは `docs/phase0-report.md`。
