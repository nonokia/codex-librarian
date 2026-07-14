# Python 抽出器ベースライン — issue #6 (ADR-2 多言語パス)

日付: 2026-07-14 / 対象: `eval/fixtures/python-taskflow`(21 files / 81 symbols / 190 edges,
うち unresolved 40)/ 正解セット: `eval/golden/python-taskflow.json`(12 ケース — **#16 の
外部 `.scip` 取り込みで使ったものと同一**)

## 何を作ったか

`Extractor` インターフェースの Python 実装。抽出本体は `py-extractor/extract.py`(**標準
ライブラリ `ast` のみ**、依存ゼロ・ビルド不要)で、librarian は Go/PHP/Terraform と同じ
subprocess プラグイン(ADR-7)として子プロセスで呼ぶ(stdin: `{root, files}` / stdout:
SCIP+ 封筒 `{scip, ext}`)。store・retrieval・UI は行がどの言語から来たかを知らない。

**この言語だけの特殊事情: 同じ fixture・同じ golden で「外部インデクサ(scip-python)取り込み」
のベースラインが既にある**(`docs/scip-baseline.md`、micro recall 88.1%)。したがって本 issue の
数値は他言語と違い、**同一条件の A/B 比較**として読める(下表)。

### パーサ選定(ADR-2 の「型解決必須」との折り合い)

| 候補 | 判断 |
|---|---|
| **標準ライブラリ `ast` + 自前の名前解決**(採用) | パーサは CPython 本体 = 文法の再実装なし。依存ゼロでインタプリタさえあれば動く(PHP レグと同じ「配布物はスクリプト 1 本」) |
| scip-python(外部インデクサ) | 却下(native レグとしては)。node/npm 依存が重く、**取り込み口は既に `librarian import` で存在する**(#16 degrade 経路)。native を書く意味は ext サイドカー(エッジ種別・unresolved・testblock)を得ること |
| Jedi / Pyright ベースの解決 | 却下。pip/npm の実行時依存が増え「ローカル完結・運用ミドルウェア無し」(ADR-1)に反する。推論の強さは魅力だが、それが欲しい場合の答えは **scip-python を `import --prefer-scip` で取り込む**ことであって native レグを重くすることではない |
| tree-sitter | 却下(ADR-2 どおり)。構文のみで名前解決が無く、偽エッジ/欠落エッジを生む |

Python には標準の型チェッカが無い。ADR-2 の「型解決必須」に対する本 issue の答えは
**「型推論器を積む」ではなく「静的な名前解決を書き、解けないものは resolved=0 で残す」**:

- import グラフ(絶対 / 相対 / サブモジュール)、モジュール単位の束縛表
- クラス階層と in-repo MRO(多重継承 mixin を含む)
- 小さな型環境: `self`/`cls`、注釈付き引数、`x = Foo()`、注釈付き戻り値、コンテナの
  要素型(`List[Task]` → ループ変数は `Task`)、`__init__` で学習する属性型
  (`self._store: Store`)
- **override エッジ**(`MemStore.complete --extends--> Store.complete`): Python には
  `@Override` が無く、実装と契約を静的に結ぶ唯一の線。これが無いと「注入インターフェース
  越しの呼び出し元」に到達できない(呼び出しは契約側のメソッドに解決されるため)。
  degrade 経路が SCIP の `is_implementation` から復元しているものと同じ関係を native でも張る。

解けないもの(duck typing のレシーバ、`getattr`、サードパーティ由来の callable、
組み込み関数)は **resolved=0 + 生名**で保持する(invariant: 計測可能性 > 完全性)。

パース忠実度は**実行するインタプリタの文法バージョンに縛られる**。新しい構文のファイルは
その 1 ファイルだけ file-level に degrade(警告付き)し、run 全体は止めない。署名文字列は
`ast.unparse`(3.9+)に頼らず自前レンダラで生成する — **どの python3 で抽出しても store の行が
同じ**であることが不変条件だから。

## ベースライン(hops=2, budget=8000, 既定戦略 — 全言語と同一)

| 指標 | native(本 issue) | 外部 scip-python 取り込み(#16) |
|---|---|---|
| ケース数 | 12 | 12(同一 golden) |
| **micro recall** | **95.2%**(40/42) | 88.1%(37/42) |
| macro recall | 94.4% | 86.1% |
| 完全一致ケース | **10/12** | 8/12 |
| 平均取得 items / chars | 23.3 / 4,189 | 27.3 / 7,587 |
| symbols / edges | 81 / 190(unresolved 40) | 77 / 307(unresolved 154) |

**native が +7.1pt。しかも取得コストは 45% 小さい**(4,189 vs 7,587 chars)。理由は
scip-baseline.md が予告したとおりで、逆から効いた:

- degrade 経路はエッジ種別を失い**全て references** になるため、エッジが 307 本に膨らみ、
  budget 圧迫による elision が起きていた(pytf-008 の miss はこれ)。native は
  calls/imports/extends/references の重み差が効くので、**少ないコンテキストで同じ近傍**を取る。
- degrade 経路が native(PHP)に勝っていた唯一の理由 —— pyright の型推論による
  「注入インターフェース越しの呼び出し」の解決 —— は、本実装が `__init__` 属性型学習 +
  override エッジで**同じ結線を静的に再現**したため差が消えた(pytf-001 は両者 100%)。

つまり「型推論器が無いと取れない」と思われていた信号の実体は、**属性型の学習と override 関係**
だった。これは他言語(PHP native の既知の弱点)にも移植できる知見。

## 失敗分析(2 miss、いずれも既知の failure mode)

- **pytf-004 / pytf-005: シンボル粒度の miss。** `Store` / `Reader` 契約を変更したとき、
  期待は `Service`(クラス)だが retrieval が surface するのは依存点である
  `Service.__init__`(注釈が置かれているメソッド)。**PHP の ptf-004/005、scip-python の
  pytf-004/005/009 と同型**で、言語横断で再現する failure mode(golden からは削らない)。
  正しい対処は抽出器側の帰属の付け替えではなく、retrieval が近傍のコンテナ行も surface する
  こと — 別 issue の議題。
- scip-python が落としていた **pytf-008 / pytf-009 は native では取れている**(elision が
  起きないため)。

## 外部 `.scip` 取り込みとの共存(dispatch)

設計 §4.5 の「native が常に勝つ」により、**Python に native レグができた時点で、ext サイドカー
無しの `.scip`(scip-python 出力)取り込みは `.py` ドキュメントをスキップする**ようになった
(`skippedNativeFiles`)。pyright 由来の推論が欲しい等の理由で**外部 index を優先したい場合は
明示的に** `librarian import <index.scip> --prefer-scip` を使う(既定は native 優先のまま。
黙って挙動が変わることはない)。`docs/scip-baseline.md` の再現手順もこのフラグを使う。

## 再現手順

```bash
npm run build
node dist/cli.js index eval/fixtures/python-taskflow --db /tmp/pytf.db
node dist/cli.js eval eval/golden/python-taskflow.json --db /tmp/pytf.db --pretty
```

`python3` があれば追加の準備は不要(抽出器は標準ライブラリのみ)。別のインタプリタを使う場合は
`PYTHON_BINARY=/path/to/python3.12`。
