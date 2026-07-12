# PHP 抽出器ベースライン — issue #8 (ADR-2 多言語パス)

日付: 2026-07-12 / 対象: `eval/fixtures/php-taskflow`(16 files / 75 symbols / 140 edges,
うち unresolved 58)/ 正解セット: `eval/golden/php-taskflow.json`(12 ケース)

## 何を作ったか

`Extractor` インターフェースの PHP 実装。抽出本体は `php-extractor/extract.php`(PHP 製の
スクリプト、**nikic/php-parser** = PHPStan / Psalm が土台にする AST ライブラリ + その
`NameResolver` を使う)で、librarian はそれを子プロセスとして呼ぶ
(stdin: `{root, files}` / stdout: `ExtractionResult[]`)。store・retrieval・UI は行がどの
言語から来たかを知らない(#10 のディスパッチのまま)。

パーサは `php-extractor/vendor/` に同梱してコミットしてあるので、**必要なのは `php` 処理系
だけ**(ビルド不要 — Go の `go build` に相当する手順がない)。方式比較(issue #8 の前提)は
`php-extractor/extract.php` の冒頭コメントに記録:**nikic/php-parser 方式を採用**、
SCIP 系インデクサ取り込みは Go と同じ理由(外部インデクサ依存 + occurrence モデルの再写像
レイヤが増えるだけ)で見送り、tree-sitter-php は名前解決を持たないためフォールバック未満と
判断。

- symbols: module(ファイル、signature に `namespace <Ns>`)/ function / class / interface /
  **trait** / enum(PHP 8.1)/ method(クラス = container)/ testblock / variable
  (namespace レベルの `const`)。`trait` は Go の struct と違い既存の kind に無いので
  `SymbolKind` に 1 つ追加した。
- edges: calls / imports(`use` → 対象ファイル module)/ extends(`extends` ・ `implements` ・
  **trait use** をすべて extends に集約)/ references(型ヒント・`::class`・`instanceof`・
  `catch` 型)。
- **解決の要は名前空間 + `use`(PHP の PSR-4)**。NameResolver が全参照を FQN に正規化する
  ので、`use App\Store\Store;` 経由の参照も第一級で解決される。

### 解決できるもの / できないもの(方針は TS・Go と同一 = 測れることを優先)

静的に決まる呼び出しだけ resolved にする:

- resolved: 自由関数呼び出し(名前空間→グローバルのフォールバック込み)、`new Foo()`、
  静的呼び出し `Foo::bar()` / `self::` / `static::` / `parent::`、そして **`$this->method()`**
  (唯一、型推論なしで解決できるインスタンス呼び出し。extends チェーンも遡る)。
- unresolved(`resolved=0` + 記述どおりの生名): 一般のインスタンス呼び出し
  `$obj->method()`、動的ディスパッチ `$obj->$method()` / `new $class`、マジックメソッド、
  そして vendor / 標準ライブラリ(`RuntimeException` 等)。issue #8 の「動的呼び出しは
  `resolved=0` に落とす」要件そのもの。

## ベースライン(hops=2, budget=8000, 既定戦略 — TS・Go と同一)

| 指標 | 値 |
|---|---|
| ケース数 | 12(target 式 11 + 実 diff 式 1) |
| **micro recall** | **88.1%**(37/42) |
| macro recall | 87.5% |
| 完全一致ケース | 8/12 |
| 平均取得 items / chars | 15.5 / 3,674 |

Go fixture(95.7%)より低いのは PHP の性質そのもの:**依存注入したインターフェース越しの
呼び出し(`$this->store->complete()`)は型推論なしでは解決できない**ため、レイヤ間の
「呼び出し」エッジが calls ではなく参照・生成(型ヒント・`new`)経由でしか繋がらない。
retrieval はメソッド diff で外側のクラスを共シード(span 包含)するので、クラスレベルの
接続(`new` / 型ヒント / implements)で多くは届くが、下の 5 miss は届かない。

## 失敗分析(5 miss)

いずれも**同じ根本原因: 注入インターフェース越しの動的ディスパッチ**(Go の gtf-001 と
同型の「interface 間接呼び出し」問題が、PHP では常態化する)。

1. **ptf-001: `Service::completeTask` / `Handler::handleComplete` が取れない。**
   `$this->store->complete()` は unresolved なので、`MemStore::complete ← Service::completeTask`
   の calls エッジが存在しない。
2. **ptf-003: `Service::overdueTasks` が取れない。** `$task->overdue($now)` が unresolved
   (ローカル変数のインスタンス呼び出し)。
3. **ptf-004 / ptf-005: `Service`(クラス)が取れない。** 依存点は `Service::__construct` の
   `private Store $store`(resolved references)で、retrieval はそのメソッドを surface する
   が、正解は「Service クラス」を指しているのでシンボル粒度で外れる。

どれも正解セットから削らない(`eval/README.md` の規律どおり、この差分が改善対象そのもの)。
「注入インターフェースの実装エッジを 1 hop に畳む / references の重みを上げる」戦略が
`librarian learn` の候補になる — 言語固有のエッジ形状が学習対象になる好例(Go の interface
間接呼び出し・TS の JSX と同じ構図)。

## 再現手順

```bash
npm run build
node dist/cli.js index eval/fixtures/php-taskflow --db /tmp/ptf.db     # php があれば自動で使う
node dist/cli.js eval eval/golden/php-taskflow.json --db /tmp/ptf.db \
  --repo eval/fixtures/php-taskflow --pretty
```

`php` 処理系が無い環境では `.php` はファイルレベル module に degrade する(インデックス
全体は失敗しない)。
