# code-on-board — Codex Librarian

Personal experiment to reverse-engineer the concept of Nexon's CodeOnBoard (NDC26),
re-designed for individual-developer scale. コードベースの「理解負債」を返済する
graph-first な AI レビュー & 知識資産化プラットフォーム。

- **設計書(source of truth): [`docs/architecture.md`](docs/architecture.md)** — 原則・ADR・フェーズ計画
- **検証レポート: [`docs/validation-weather-you-travel.md`](docs/validation-weather-you-travel.md)**
- 意思決定ログ: [`dlog`](https://github.com/nonokia/dlog) で記録し、`.dlog/dlog.db` をコミットしている。
  `dlog why src/app/index.ts` などで「なぜこうなっているか」を照会できる(運用ルールは `AGENTS.md` / `CLAUDE.md`)。

## Status

- **Phase 0 実装済み**: 評価ハーネス(`librarian eval`)+ 正解セット 16 ケース
  (weather-you-travel 由来)。ベースライン **micro recall 69.6%** —
  詳細と失敗分析は [`docs/phase0-report.md`](docs/phase0-report.md)。
- **Phase 1 スライス実装済み**: TypeScript Compiler API による型解決済み symbols/edges
  抽出(ADR-2)、単一 SQLite の Knowledge Store + 再帰 CTE k-hop 探索(ADR-1)、
  決定的展開リトリーバ(`librarian retrieve`、ADR-3 の stage 1)。
- **Phase 2 実装済み(MVP)**: 区画付き Context Pack 組み立て(`librarian pack`)、
  Claude API による文脈接地レビュー生成(`librarian review`、構造化出力 + findings ごとの
  根拠セクション記録)、GitHub Actions テンプレート(`templates/librarian-review.yml`)。
- **Phase 4 実装済み**: RetrievalLog + diff シグネチャ → 戦略の PatternCache +
  戦略探索(`librarian learn`)。micro recall 69.6% →(チューニング)87.0% →
  (PatternCache)**89.1%**。ただし holdout では改善が示せておらず、汎化の主張には
  正解セットの成長が先 — 詳細は [`docs/phase4-report.md`](docs/phase4-report.md)。
- **Phase 3 実装済み**: Web UI(`web/`、Next.js)—「図書館」体験のデモ。
  蔵書目録(統計 + 精度時系列 + PatternCache + retrieval_log)、書架を歩く
  (シンボル検索 → k-hop 近傍のグラフ可視化 + ソース閲覧)、司書に聞く
  (グラフ近傍を文脈にした Q&A、要 ANTHROPIC_API_KEY)。

  ```bash
  npm run build                       # 先に root で(web は dist/ を参照)
  cd web && npm install
  LIBRARIAN_DB=/path/to/idx.db npm run dev   # http://localhost:3000
  ```
- 意味的補完(embeddings)は未着手 — ask は語彙一致 + グラフ近傍で動く(UI に明記)。
- **Go 対応実装済み(issue #7)**: `go-extractor/`(`golang.org/x/tools/go/packages`
  ベースの抽出バイナリ)を子プロセスとして呼ぶ第 2 の Extractor。正解セット 12 ケース、
  fixture ベースライン micro recall 95.7% — 詳細は [`docs/go-baseline.md`](docs/go-baseline.md)。
- **PHP 対応実装済み(issue #8)**: `php-extractor/`(nikic/php-parser + NameResolver ベースの
  抽出スクリプト、パーサ同梱)を子プロセスとして呼ぶ第 3 の Extractor。namespace + `use`
  (PSR-4)を第一級で解決。正解セット 12 ケース、fixture ベースライン micro recall 88.1% —
  詳細は [`docs/php-baseline.md`](docs/php-baseline.md)。
- **SCIP+ 実装済み(issue #16, ADR-6 提案)**: 抽出器⇄store の交換フォーマットを
  SCIP ベース層 + ext サイドカーの二層に。3 言語の native 抽出器はすべて SCIP+ emit、
  `librarian export --scip` / `import`、外部 `.scip`(scip-python)の degrade 取り込みで
  **抽出器を書かずに Python が増えた**(micro recall 88.1%)— 設計は
  [`docs/scip-design.md`](docs/scip-design.md)、実測は
  [`docs/scip-baseline.md`](docs/scip-baseline.md)。

## Go リポジトリのインデックス

`.go` ファイルは Go 製の抽出バイナリ(`go-extractor/`)で symbols/edges 化される。
librarian は以下の順でバイナリを探す:

1. `LIBRARIAN_GO_EXTRACTOR` 環境変数(ビルド済みバイナリへのパス)
2. `librarian-go-extractor` が `$PATH` 上にある(推奨: `go install ./go-extractor` 後、
   `mv $(go env GOPATH)/bin/go-extractor $(go env GOPATH)/bin/librarian-go-extractor`
   か `go build -o <PATHの通った場所>/librarian-go-extractor ./go-extractor`)
3. Go toolchain(1.24+)があれば `go run ./go-extractor` に自動フォールバック(初回は
   ビルドの分だけ遅い)

どれも無い場合、`.go` ファイルはファイルレベルの module シンボルのみに degrade する
(インデックス全体は失敗しない。警告が stderr に出る)。制約: 対象リポジトリは
ルートに `go.mod` を持つこと(非モジュール/ネストモジュールはファイルレベルに degrade)。

## PHP リポジトリのインデックス

`.php` ファイルは PHP 製の抽出スクリプト(`php-extractor/extract.php`、nikic/php-parser を
`php-extractor/vendor/` に同梱)で symbols/edges 化される。**インタプリタ実行なのでビルド
手順は無く、必要なのは `php` 処理系だけ**。librarian は以下の順でスクリプトを探す:

1. `LIBRARIAN_PHP_EXTRACTOR` 環境変数(`extract.php` へのパス。隣に `vendor/` が必要)
2. リポジトリ同梱の `php-extractor/extract.php`(既定)

`php` バイナリは `PHP_BINARY` で上書きできる(既定は `$PATH` の `php`)。名前解決は namespace +
`use`(PSR-4)ベースで、`use App\Store\Store;` 越しの参照も解決される。型推論は行わないので、
一般のインスタンス呼び出し(`$obj->method()`)・動的ディスパッチ(`$obj->$method()`)・
マジックメソッドは `resolved=0` + 生名で保持する(`$this->method()` と静的/`new`/`self`・
`parent`・`static` 呼び出しは解決する)。

`php` もスクリプトも無い場合、`.php` ファイルはファイルレベルの module シンボルのみに
degrade する(インデックス全体は失敗しない。警告が stderr に出る)。

## SCIP での export / import(issue #16)

抽出器⇄store の交換フォーマットは **SCIP ベース層 + ext サイドカーの二層(SCIP+)**
(設計: [`docs/scip-design.md`](docs/scip-design.md))。index を標準準拠の `.scip` として
持ち出せ、外部 SCIP インデクサの出力を取り込める。

```bash
# export: 標準準拠の .scip と librarian 固有信号の .scip-ext.json のペアを書き出す
node bin/librarian.js export --scip out.scip --db <db> [--repo <name>]

# import: <base>.scip-ext.json が隣にあれば SCIP+(行の完全復元)、無ければ degrade 取り込み
node bin/librarian.js import out.scip --db <db> [--repo-name <name>] [--root <dir>]
```

**外部インデクサで native 未対応言語を足す**(抽出器を書かずに 1 言語増える)。例: Python —

```bash
npm install -g @sourcegraph/scip-python
scip-python index <repo> --output index.scip
node bin/librarian.js import index.scip --db <db> --root <repo>
```

ext サイドカーの無い `.scip` は degrade 規則で取り込む(設計 §4.5): Import role →
imports、`is_implementation` → extends、残りの参照は一律 references。unresolved は
存在せず、testblock は部分再構成。native との差の実測(= ext の価値)は
[`docs/scip-baseline.md`](docs/scip-baseline.md)(scip-python: micro recall 88.1%)。

**dispatch 優先度 — native が常に勝つ**(設計 §4.5): degrade `.scip` 内のドキュメントの
うち、native extractor が claim する拡張子(`.ts`/`.js`/`.go`/`.php` …)のものは
スキップされる(レポートの `skippedNativeFiles`)— それらの言語は `librarian index` が
richer な取り込み口。ext サイドカー付き(`librarian export --scip` の出力)は native
信号そのものなのでスキップされない。`index` と `import` はファイル削除の管轄を
「自分が扱う拡張子」に限定するため、**同一 db・同一 repo で共存できる**
(例: TS は native インデックス、Python は scip-python の import)。

## 自己インデックス(dogfooding, issue #15)

librarian 自身のコードグラフを **リポジトリにコミットして持ち運ぶ**(`.dlog/dlog.db` と対になる実験)。
エージェント/開発者は全ファイルを読む代わりに、committed の知識から着手できる:

- `.librarian/MAP.md` — grep で読める決定的コードベースマップ(ファイル→シンボル、
  imports、シンボル間 edges、unresolved 集計)。一次成果物。
- `.librarian/self.db` — CLI クエリ用の index(`src/` + `web/` のみ。fixture は含めない)。

```bash
node bin/librarian.js graph indexRepo --db .librarian/self.db --pretty   # 変更前に近傍を引く
node bin/librarian.js pack <diff> --db .librarian/self.db                # 変更の Context Pack
npm run selfindex          # 再生成(index + MAP.md)— src/ or web/ を変えたら
npm run selfindex:check    # drift 検出: 再生成した map と committed の diff(stale なら exit 1)
```

**更新手順**: `src/`・`web/` を変更したコミットの後に `npm run selfindex` を実行し、
`.librarian/self.db` + `.librarian/MAP.md` を次のコミットで取り込む(dlog と同じ
**1 コミット遅れ**の追従)。no-op の再実行は byte-identical(git diff ゼロ)なので、
stale 判定は `selfindex:check` = 「再生成して差分が出たら stale」で閉じる。

注意: `graph`/`symbols`/`file`/`map`/`stats` は読み取り専用だが、**`pack`/`review` は
retrieval_log(§4-⑤ の feedback 信号)を db に書き込む**。残す意図がなければ
`git checkout .librarian/self.db` で戻す。

## Quick start

```bash
npm install && npm run build
node bin/librarian.js index <repo>        # インデックス(<repo>/.librarian/index.db)
node bin/librarian.js stats --db <db>
node bin/librarian.js graph <symbol> --db <db> --hops 2 --pretty
node bin/librarian.js retrieve <diff-file> --db <db> --budget 8000   # 文脈束
node bin/librarian.js eval eval/golden/weather-you-travel.json --db <db> --pretty
```

## マルチレポ(issue #11)

複数リポジトリを 1 つの db にインデックスして横断で引ける(schema v2)。

```bash
node bin/librarian.js index ~/src/repo-a --db shared.db            # repo 名は basename
node bin/librarian.js index ~/src/repo-b --db shared.db --repo-name backend
node bin/librarian.js symbols handleRequest --db shared.db          # 既定で横断検索
node bin/librarian.js graph handleRequest --db shared.db --repo backend  # --repo で絞り込み
node bin/librarian.js stats --db shared.db                          # repos / repo 別内訳
```

- diff 系(`retrieve`/`pack`/`review`/`eval`)はソース本文を repos テーブルの root から
  読む。同じ相対パスが複数 repo にある場合は `--repo <name>` で diff の属する repo を
  指定する。インデックス時と root が移動した場合は `--root <dir>` で上書き。
- v2 より前の db は開けない(再インデックスを案内するエラーになる)。
- リポジトリ間の import は静的には解決できないため `resolved = 0` のまま
  (unresolved として隔離)。package 名 → repo マッピングによる解決は将来課題。
