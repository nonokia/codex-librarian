# Go 抽出器ベースライン — issue #7 (ADR-2 多言語パス)

日付: 2026-07-12 / 対象: `eval/fixtures/go-taskflow`(10 files / 61 symbols / 300 edges,
うち unresolved 96)/ 正解セット: `eval/golden/go-taskflow.json`(12 ケース)

## 何を作ったか

`Extractor` インターフェースの Go 実装。抽出本体は `go-extractor/`(Go 製の小さな
バイナリ、`golang.org/x/tools/go/packages` = 公式型チェッカベース)で、librarian は
それを子プロセスとして呼ぶ(stdin: `{root, files}` / stdout: `ExtractionResult[]`)。
store・retrieval・UI は行がどの言語から来たかを知らない(#10 のディスパッチのまま)。

方式比較(issue #7 の前提)は dlog `01KX9YHSRNTHCAE0JG8S19AQRW` に記録:
**go/packages バイナリ方式を採用**、SCIP(scip-go)取り込みは「外部インデクサ依存 +
occurrence モデルの再写像レイヤが増えるだけで精度が上がらない」ため却下。

- symbols: module(ファイル、signature に `package <name>`)/ function / method
  (レシーバ = container)/ struct / interface / typealias / variable / testblock
  (`TestXxx` と `t.Run` サブテストのネスト、TS の describe/it と同形)
- edges: calls(型解決済み。interface 経由の呼び出しは interface シンボルに解決)/
  imports(ファイル module → 対象パッケージの各ファイル module)/ extends
  (embedding **+ interface 実装** — `types.Implements` の総当たり)/ references。
  未解決は `resolved=0` + 記述どおりの生名(`fmt.Errorf` 等)。

## ベースライン(hops=2, budget=8000, 既定戦略 — TS と同一)

| 指標 | 値 |
|---|---|
| ケース数 | 12(target 式 11 + 実 diff 式 1) |
| **micro recall** | **95.7%**(45/47) |
| macro recall | 96.7% |
| 完全一致ケース | 10/12 |
| 平均取得 items / chars | 23.1 / 4,065 |

数字が weather-you-travel ベースライン(69.6%)より高いのは、対象がこの issue のために
書いた小さな整った fixture であり、2-hop でグラフのほぼ全域に届くため。**これは
「Go 抽出器のグラフが retrieval にそのまま機能する」ことの証明であって、Go での精度
一般の主張ではない。** 実 OSS リポジトリでの計測は正解セットの成長と合わせて次の課題
(この環境からは外部リポジトリを取得できないため、対象リポジトリは fixture をコミット
する形にした)。

## 失敗分析(2 miss)

1. **gtf-001: `Service.CompleteTask` が取れない。** 呼び出しは `store.Store`
   (interface)経由なので、グラフ上は `MemStore.Complete → (implements) → Store ←
   (calls) ← CompleteTask` の 3 エッジ相当になり hops=2 の重み減衰で届かない。
   interface 間接呼び出しは Go では常態なので、「implements エッジを 1 hop 側に
   畳む/重みを上げる」戦略が learn の候補になる — TS の JSX と同じく言語固有の
   エッジ形状が学習対象になる好例。
2. **gtf-008: `TestHandleCreate` が取れない。** `handleCreate` はテストから直接
   呼ばれず `Routes` 登録経由(references)のため、`←references·←calls` の 2-hop
   スコア(0.7×1.0×0.65²)が同予算の他候補に負ける。テスト到達性はセクション別
   予算(tests 区画の最低保証)で救える可能性がある。

どちらも正解セットから削らない(eval/README.md の規律どおり、差分が改善対象)。

## 再現手順

```bash
npm run build
go build -o /tmp/librarian-go-extractor ./go-extractor   # または go install ./go-extractor
LIBRARIAN_GO_EXTRACTOR=/tmp/librarian-go-extractor \
  node dist/cli.js index eval/fixtures/go-taskflow --db /tmp/gtf.db
node dist/cli.js eval eval/golden/go-taskflow.json --db /tmp/gtf.db --pretty
```
