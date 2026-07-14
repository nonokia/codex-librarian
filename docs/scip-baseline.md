# 外部 `.scip` 取り込みベースライン — issue #16 Step 4(degrade 経路)

日付: 2026-07-13 / 対象: `eval/fixtures/python-taskflow`(21 files / 77 symbols / 307 edges,
うち unresolved 154)/ 正解セット: `eval/golden/python-taskflow.json`(12 ケース,
php-taskflow の移植)/ インデクサ: **scip-python 0.6.6**(外部ツール、抽出器は書いていない)

## 何を測ったか

ADR-6 の受け入れ条件「外部 `.scip` を取り込んで(ext 欠落のまま)`graph`/`pack` が動く言語が
最低 1 つ = **抽出器を書かずに 1 言語増える**」の実測。この数値は**改善対象ではなく
ベースライン記録**(設計 §5 — native との差 = ext サイドカーの価値の実測になる)。

```
npx @sourcegraph/scip-python index . --project-name python-taskflow \
  --project-version 0.1.0 --output index.scip        # fixture ルートで実行
librarian import index.scip --db /tmp/pytf.db        # ext サイドカー無し → degrade
```

生成した `index.scip` は fixture にコミット済み(再現に scip-python 不要)。
`.scip` の `metadata.projectRoot` は生成マシンの絶対パスなので、別環境では
`librarian import ... --root eval/fixtures/python-taskflow` で上書きする。

## degrade 経路が実データに合わせて吸収したもの(設計 §6-4 の実測)

scip-python 0.6.6 の出力は設計時の想定より粗い。ingest 側の対応と合わせて記録:

| scip-python 0.6.6 の実態 | degrade ingest の対応 |
|---|---|
| `SymbolInformation.kind` が**全件 0(Unspecified)** | moniker の descriptor suffix から kind を導出(`#`→class、`().`→method/function、`.`→module レベルのみ variable) |
| `SymbolRole.Import` を**一度も立てない**(import 文は ReadAccess) | module 形 moniker(`__init__:` / namespace のみ)への参照を imports と解釈 |
| module symbol は `…/__init__:` | 各 Document に合成する module 行へ**エイリアス** → 文書間 imports が native 同様 resolved で繋がる |
| range は全件 deprecated の `repeated int32`(typed_range 不使用) | legacy 形式のフォールバック実装 |
| `signatureDocumentation` 無し(署名は `documentation[]` の fenced code block) | fenced block → signature、平文 → doc に分離 |
| `SymbolRole.Test` 無し | testblock は再構成されない(設計どおりの欠落) |
| メソッド override にも `is_implementation`(`MemStore#get()` → `Reader#get()`) | メソッド→メソッドの extends エッジとして保持(下記の副産物) |
| クラス属性(`MemStore#_tasks.` 等)が第一級 symbol | 落とす(native 抽出器は field 行を出さない)— 本 fixture では skippedSymbols=12 |

## ベースライン(hops=2, budget=8000, 既定戦略 — 3 言語 native と同一)

| 指標 | 値 |
|---|---|
| ケース数 | 12(target 式 11 + 実 diff 式 1) |
| **micro recall** | **88.1%**(37/42) |
| macro recall | 86.1% |
| 完全一致ケース | 8/12 |
| 平均取得 items / chars | 27.3 / 7,587 |

**PHP native(88.1%)と同値、Go native(95.7%)より低い。** ただし内訳は PHP と異なる:

- **PHP native の主敗因だった「注入インターフェース越しの呼び出し」が、ここでは取れている**
  (pytf-001 は 100%)。pyright は `store: Store` の型注釈から `self._store.complete(id)` を
  `Store#complete()` に解決し、さらにメソッド override の `is_implementation` が
  `MemStore.complete —extends→ Store.complete` を張るため、契約⇄実装がグラフで往復できる。
  **型推論持ちの外部インデクサは、エッジ種別を失っても native の弱点を別方向から補う**
  — これが degrade 経路の実測が示した最大の発見。
- 代償は **エッジ種別の消失**: calls/references の重み差(1.0/0.7)が消え全て references、
  testblock も無い。エッジ総数は膨らむ(307 本、native PHP は 140 本)ため、
  budget 圧迫による elision が起きやすい(下記 pytf-008)。

## 失敗分析(5 miss)

1. **pytf-004 / pytf-005 / pytf-009: クラス粒度の miss(4 件中 3 件)。** 依存点が
   `Service.__init__` / `Task.__init__` のシグネチャ型注釈にあり、retrieval はメソッド行を
   surface するが正解は「クラス」を指す。PHP の ptf-004/005 と同型のシンボル粒度問題
   (言語横断で再現する failure mode — golden からは削らない)。
2. **pytf-008: `Sequence` と `test_add_assigns_sequential_ids`。** グラフにはどちらも
   depth 1 で存在する(`add —references→ Sequence.next_id`、`test_add —references→ add`)が、
   全 references 化でエッジが増えた結果 budget elision に呑まれた(このケースの elided は
   19 items)。degrade 用の重み戦略(種別区別なし)を `librarian learn` の掃引対象にする
   計画(設計 §4.5)がまさにここに効くはず。

## native との差分(= ext サイドカーの価値)

| 信号 | native(ext あり) | 外部 .scip(degrade) |
|---|---|---|
| エッジ種別 | calls/imports/extends/references + 重み | imports(ヒューリスティック)/ extends(relationship)/ 他は一律 references |
| unresolved | 第一級(`map` の集計対象) | index 外参照のみ(154 本 — stdlib/typing が大半) |
| testblock | ネスト込み第一級 | 無し(pytest 関数は function 行として拾える) |
| 型推論 | 言語による(PHP は無し) | pyright 由来で強い(上記) |

## 追記(issue #6 以降): Python に native レグができた

#6 で `py-extractor/`(標準ライブラリ `ast`)が入り、**`.py` は native extractor が claim する
拡張子になった**。設計 §4.5 の「native が常に勝つ」により、ext サイドカー無しの `.scip` 取り込みは
`.py` ドキュメントを既定でスキップする。本ページの数値を再現する / あえて外部インデクサの
推論を使うには **`--prefer-scip`(明示的なオプトアウト)**が要る。

同一 golden での比較は `docs/python-baseline.md`: **native 95.2% vs degrade 88.1%**。
本ページの「型推論持ちの外部インデクサは native の弱点を別方向から補う」という発見は、
native 側が `__init__` 属性型の学習 + override エッジで同じ結線を静的に再現したことで
**差分としては解消した**(発見自体は有効 — それが native の設計指針になった)。

## 再現手順

```bash
npm run build
node dist/cli.js import eval/fixtures/python-taskflow/index.scip \
  --db /tmp/pytf.db --root eval/fixtures/python-taskflow --prefer-scip
node dist/cli.js eval eval/golden/python-taskflow.json --db /tmp/pytf.db --pretty
```

`.scip` を作り直す場合(要 node、scip-python は npx が取得):

```bash
cd eval/fixtures/python-taskflow
npx --yes @sourcegraph/scip-python index . --project-name python-taskflow \
  --project-version 0.1.0 --output index.scip
```
