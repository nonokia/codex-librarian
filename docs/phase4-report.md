# Phase 4 レポート — 自己改善ループ(RetrievalLog / PatternCache)

日付: 2026-07-10 / 対象: `nonokia/weather-you-travel`(golden 16 ケース)
成果物: 全リトリーバル試行の記録(retrieval_log)、diff シグネチャ → 戦略の
PatternCache、戦略探索(`librarian learn`)、精度の時系列(`librarian history`)。

## 仕組み(§4-⑤ / ADR-3 の実装形)

1. **決定的パイプラインが基盤。** リトリーバル戦略(hops / decay / エッジ重み /
   fileDamp)をパラメータ化し、既定値は Phase 0 で計測したベースラインのまま。
2. **diff シグネチャ**: シードの種別・ディレクトリ(2 階層)・テスト接触・件数バケット
   から決定的に生成。粗くしてあるのはパターンを再出現させるため。
3. **探索 = 固定候補 8 戦略の掃引**を評価ハーネスで採点し、既定を上回った勝者だけを
   PatternCache に昇格。`pack` / `review` はキャッシュを既定で適用(`--no-cache` で無効)、
   `eval` は明示 `--use-cache` 時のみ(ベースライン計測を汚さないため)。
   LLM エージェントによる自由探索は後日の追加要素(ADR-3 の従)であり、
   「未知パターン→探索→成功したら昇格」という構造は今の実装と同型。
4. **フィードバック信号**(運用側、蓄積のみ開始):
   (a) `librarian review` は毎回 retrieval_log に記録し、生成された findings が
   根拠に引用した pack セクション(evidence)を書き戻す — 「LLM がその文脈を
   引用したか」の自動判定。
   (b) `librarian feedback <log-id> --good|--bad` — 人間の 👍/👎。
   これらからの昇格は運用ボリュームが溜まってから(下記 Next)。

## 計測結果

### 時系列(`librarian history` に記録)

| # | 状態 | micro recall | perfect |
|---|---|---|---|
| Phase 0 ベースライン | 既定戦略(チューニング前) | 69.6% | 8/16 |
| Phase 0 改善 1-3 | 既定戦略(現行) | 87.0% | 10/16 |
| **Phase 4** | **PatternCache 適用** | **89.1%** | **11/16** |

学習されたパターンは 1 件: `k=function|d=src/components|t=0|n=1` (コンポーネント
単体の変更)→ `slow-decay`(decay 0.65→0.8)。2-hop の props 経由隣人が減衰負け
していた失敗モード 3 に、コンポーネント diff に限って効く戦略が刺さった形。
services / utils のシグネチャでは候補 8 種のどれも既定を上回らず、既定が保持された
(むやみに上書きしないことも学習の出力である)。

### 過学習チェック(--holdout)

シグネチャごとに半分を選択から隔離した場合:

| | default | learned |
|---|---|---|
| train (10) | 87.1% | 90.3% |
| **holdout (6)** | **86.7%** | **86.7%(改善なし)** |

**16 ケースでは「学習が機能する」ことは示せるが「汎化する」ことはまだ主張できない。**
上の 89.1% は学習と評価が同一セット(train=test)であることを明記して記録している。
汎化の主張には正解セットの成長(§8 リスク 1 の緩和策 = 運用ログからの半自動追加)が
先に必要 — これが Phase 4 の数字が示した最重要の含意。

## Next

1. **正解セットの成長**: retrieval_log の review 実績(evidence / feedback)から
   golden ケースを半自動生成し、シグネチャあたりのケース数を増やす。
2. **運用シグナルからの昇格**: grounded_findings 率や 👍 の高い戦略変種を
   PatternCache に昇格する規則(現在は learn 掃引のみが昇格経路)。
3. **LLM エージェント探索**: キャッシュミス時の候補生成を固定 8 種から
   エージェント提案に拡張(ADR-3 のフォールバック)。live API 検証と同時に。

## 再現手順

```bash
node bin/librarian.js index <repo> --db idx.db
node bin/librarian.js eval  eval/golden/weather-you-travel.json --db idx.db --note baseline
node bin/librarian.js learn eval/golden/weather-you-travel.json --db idx.db --holdout --pretty
node bin/librarian.js eval  eval/golden/weather-you-travel.json --db idx.db --use-cache
node bin/librarian.js history --db idx.db   # 時系列
```
