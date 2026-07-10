# 検証レポート — weather-you-travel をインデックスする

日付: 2026-07-10 / 対象: `nonokia/weather-you-travel`(React 19 + Vite、plain JS/JSX、TypeScript なし)
目的: Phase-1 スライス(Indexer + Knowledge Store + CLI)が **TS ではない実リポジトリ** に対して
意味のあるコードグラフを作れるかのスモーク検証。ADR-4 に従い、これは精度の主張ではない
(評価ハーネス未実装のため match 率は測っていない)。

## 実行

```bash
librarian index /path/to/weather-you-travel --db wyt.db
```

| 指標 | 値 |
|---|---|
| files | 25 |
| symbols | 49 |
| edges | 254(うち unresolved 186) |
| 所要時間 | 約 1.1 秒(フルインデックス) |
| 再実行(変更なし) | filesIndexed 0(ハッシュ一致でスキップ) |

## 観察 — うまくいったこと

- **allowJs で JSX リポジトリがそのまま索引できた。** `.jsx` のアロー関数/関数コンポーネントが
  `function` シンボルとして抽出され、シグネチャ(props 分割代入)も取れる。
- **JSX → calls エッジが React の実質的な呼び出しグラフを再現した。**
  `librarian graph App --hops 1` は、レンダーする全コンポーネント
  (`FlightInput` / `FlightInfo` / `WeatherForecast` / `Skeleton` / `RecentSearches`)、
  呼び出すサービス(`getFlightDetails` / `getWeather`)、utils
  (`isValidFlightNumber` / `getRecentSearches` / `addRecentSearch`)、
  および呼び出し元(`main.jsx`、`App.test.jsx`)を 1 クエリで返す。
- **逆方向(callers)が取れる。** `librarian graph getFlightDetails` の 1-hop に
  `App` と `api.test.js` が `← calls` で現れる。「diff が触れた関数の呼び出し元を知らない」
  という §1 の課題設定に対する、最小だが本質的な答えになっている。
- **未解決参照の隔離が機能。** `fetch` / `useState` / `useTranslation` / `localStorage.getItem`
  等の外部呼び出しは resolved=0 + 生の名前で保持され、k-hop 探索を汚さない。

## 観察 — 既知の限界(次の設計課題)

1. **プロパティアクセス呼び出しの unresolved が粗い。** `localStorage.getItem` は `getItem` と
   だけ記録される。レシーバ型を checker に聞けば `console.log` 等の標準物とユーザーコードの
   メソッドを区別できるはず。Context Engine が文脈束を組むときのノイズ源になるので、
   Phase 2 前に解決したい。
2. **モジュール symbol と関数 symbol の同名衝突。** `graph App` は関数 `App` と
   モジュール `src/App.jsx` の両方にマッチする(`ambiguous` で明示はされる)。
   シンボル指定の構文(`file#name` 等)が要る。
3. **真のインクリメンタル解析は未着手。** 変更検知はファイルハッシュで行い永続化のみ差分だが、
   パースは毎回フルプログラム。§4-① の「変更ファイル+参照元のみ再解析」は HOW 設計として残る。
4. **埋め込み(Vector 役)未実装。** sqlite-vec の導入は意味的補完(§4-③ 2 段目)と同時に行う。

## 結論

Graph-first の最小ループ(index → graph 探索)は **TS 以外の実リポジトリでも成立する**。
次のマイルストーンは ADR-4 に従い Phase 0(評価ハーネス)であり、上記の限界 1〜2 は
その計測基盤ができてから数値で正当化しながら潰す。
