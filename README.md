# codex-librarian — Codex Librarian

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
- **Python 対応実装済み(issue #6)**: `py-extractor/`(標準ライブラリ `ast` のみ・依存ゼロの
  抽出スクリプト)を子プロセスとして呼ぶ Extractor。Python には標準の型チェッカが無いため、
  名前解決(import グラフ / MRO / `__init__` 属性型 / **override エッジ**)を自前で持つ。
  **同じ golden で外部インデクサ取り込み(scip-python)と直接比較できる唯一の言語**:
  native micro recall **95.2%** vs degrade 88.1%、しかもコンテキスト量は 45% 小さい — 詳細は
  [`docs/python-baseline.md`](docs/python-baseline.md)。
- **Terraform (HCL) 対応実装済み(issue #9)**: `tf-extractor/`(hashicorp/hcl ベースの
  抽出バイナリ)を子プロセスとして呼ぶ Extractor。call graph ではなく
  **リソース/モジュール参照グラフ**(`var.x` / `module.y.out` / `aws_x.y.attr`)。
  正解セット 7 ケース、fixture ベースライン micro recall 100%(HCL は参照が字句的に
  明示されるため blast radius がそのままグラフに載る)— 詳細は
  [`docs/terraform-baseline.md`](docs/terraform-baseline.md)。
- **SCIP+ 実装済み(issue #16, ADR-6 提案)**: 抽出器⇄store の交換フォーマットを
  SCIP ベース層 + ext サイドカーの二層に。native 抽出器はすべて SCIP+ emit、
  `librarian export --scip` / `import`、外部 `.scip` の degrade 取り込みで
  **抽出器を書かずに 1 言語増える**(当時の実例が Python: micro recall 88.1%。その後 #6 で
  native レグができ、外部取り込みを使うには `import --prefer-scip` が要る)— 設計は
  [`docs/scip-design.md`](docs/scip-design.md)、実測は
  [`docs/scip-baseline.md`](docs/scip-baseline.md)。

## Go リポジトリのインデックス

`.go` ファイルは Go 製の抽出バイナリ(`go-extractor/`)で symbols/edges 化される。これは
抽出器プラグインプロトコル(ADR-7、[`docs/plugin-protocol.md`](docs/plugin-protocol.md))の
**リファレンスプラグイン**でもある(コンパイル型の実例)。librarian は以下の順でバイナリを探す:

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
`php-extractor/vendor/` に同梱)で symbols/edges 化される。プロトコルの**リファレンス
プラグイン**のもう一方(インタプリタ型の実例)。**インタプリタ実行なのでビルド手順は無く、
必要なのは `php` 処理系だけ**。librarian は以下の順でスクリプトを探す:

1. `LIBRARIAN_PHP_EXTRACTOR` 環境変数(`extract.php` へのパス。隣に `vendor/` が必要)
2. リポジトリ同梱の `php-extractor/extract.php`(既定)

`php` バイナリは `PHP_BINARY` で上書きできる(既定は `$PATH` の `php`)。名前解決は namespace +
`use`(PSR-4)ベースで、`use App\Store\Store;` 越しの参照も解決される。型推論は行わないので、
一般のインスタンス呼び出し(`$obj->method()`)・動的ディスパッチ(`$obj->$method()`)・
マジックメソッドは `resolved=0` + 生名で保持する(`$this->method()` と静的/`new`/`self`・
`parent`・`static` 呼び出しは解決する)。

`php` もスクリプトも無い場合、`.php` ファイルはファイルレベルの module シンボルのみに
degrade する(インデックス全体は失敗しない。警告が stderr に出る)。

## Python リポジトリのインデックス

`.py` / `.pyi` ファイルは Python 製の抽出スクリプト(`py-extractor/extract.py`)で
symbols/edges 化される。**依存は標準ライブラリのみ**(パーサは CPython 本体の `ast`)なので、
ビルドも vendor ディレクトリも無く、必要なのは `python3` 処理系だけ。librarian は以下の順で
スクリプトを探す:

1. `LIBRARIAN_PY_EXTRACTOR` 環境変数(`extract.py` へのパス)
2. リポジトリ同梱の `py-extractor/extract.py`(既定)

インタプリタは `PYTHON_BINARY` で上書きできる(既定は `$PATH` の `python3`)。
**パース忠実度は実行するインタプリタの文法バージョンに縛られる** — 新しい構文
(`match` 文など)のファイルは、それを解釈できない python3 で走らせるとその 1 ファイルだけ
file-level に degrade する(警告付き、run 全体は止まらない)。

Python には標準の型チェッカが無いため、解決は静的な名前解決で行う: import グラフ(絶対/
相対/サブモジュール)、クラス階層と MRO、`__init__` で学習する属性型(`self._store: Store` →
`self._store.complete()` が契約メソッドに解決)、注釈付き戻り値とコンテナ要素型
(`-> List[Task]` → 内包表記のループ変数が `Task`)、そして **override エッジ**
(`MemStore.complete --extends--> Store.complete`)。duck typing のレシーバ・`getattr`・
組み込み関数は `resolved=0` + 生名で保持する。

`python3` もスクリプトも無い場合、`.py` ファイルはファイルレベルの module シンボルのみに
degrade する(インデックス全体は失敗しない)。

## Terraform リポジトリのインデックス

`.tf` ファイルは Go 製の抽出バイナリ(`tf-extractor/`、hashicorp/hcl ベース)で
symbols/edges 化される。プロトコルの**リファレンスプラグイン**でもある。他言語と違い
**call graph ではなくリソース/モジュール参照グラフ**を作る(HCL は参照が字句的に明示
され型解決が要らないため構文レベルで十分 — ADR-2 の解釈は dlog / [`docs/terraform-baseline.md`](docs/terraform-baseline.md))。
librarian は以下の順でバイナリを探す:

1. `LIBRARIAN_TF_EXTRACTOR` 環境変数(ビルド済みバイナリへのパス)
2. `librarian-tf-extractor` が `$PATH` 上にある(`go build -o <PATHの通った場所>/librarian-tf-extractor ./tf-extractor`)
3. Go toolchain があれば `go run ./tf-extractor` に自動フォールバック(初回はビルドの分だけ遅い)

シンボルは Terraform の参照アドレスで命名される(`aws_instance.web` / `var.region` /
`module.vpc` / `data.aws_ami.ubuntu` / `local.tags` / `output.ip`)。ファイル自体は
module シンボル(`module` ブロックと同じ kind だが moniker で区別)。ローカル module の
`source` は対象ディレクトリのファイルに解決し、registry/remote source は `resolved=0`。

どれも無い場合、`.tf` ファイルはファイルレベルの module シンボルのみに degrade する
(インデックス全体は失敗しない。警告が stderr に出る)。

## SQL リポジトリのインデックス

`.sql` ファイルは Go 製の抽出バイナリ(`sql-extractor/`、libpg_query =
PostgreSQL 本体のパーサのライブラリ版)で symbols/edges 化される。Terraform と同じく
**call graph ではなくリレーション/ルーチン参照グラフ**を作る(SQL は宣言と参照が
字句的に明示され型解決が要らないため構文レベルで十分 — ADR-2 の解釈は dlog /
[`docs/sql-baseline.md`](docs/sql-baseline.md))。**方言は Postgres のみ**で
`--capabilities` の `dialect` に申告される。他方言のファイルはパース失敗として
ファイルレベルに degrade する(偽エッジより欠落)。librarian は以下の順でバイナリを探す:

1. `LIBRARIAN_SQL_EXTRACTOR` 環境変数(ビルド済みバイナリへのパス)
2. `librarian-sql-extractor` が `$PATH` 上にある(`go build -o <PATHの通った場所>/librarian-sql-extractor ./sql-extractor`)
3. Go toolchain があれば `go run ./sql-extractor` に自動フォールバック(初回はビルドの分だけ遅い)

シンボルは参照アドレスで命名される(`table.users` / `view.active_tasks` /
`matview.project_task_stats` / `function.complete_task` / `procedure.archive_done_tasks` /
`trigger.tasks_audit` / `index.idx_tasks_status`)。ファイル自体は module シンボル。
FOREIGN KEY / FROM / JOIN / EXECUTE FUNCTION が references エッジになり、function /
procedure の本体は LANGUAGE sql・`BEGIN ATOMIC`・plpgsql(埋め込みクエリの best-effort
再パース)の 3 段階で辿る。migration は畳み込まずファイル単位で参照を吐く。

どれも無い場合、`.sql` ファイルはファイルレベルの module シンボルのみに degrade する
(インデックス全体は失敗しない。警告が stderr に出る)。

## Dockerfile のインデックス

`Dockerfile` / `Dockerfile.*` / `*.dockerfile` は Go 製の抽出バイナリ
(`dockerfile-extractor/`、BuildKit 公式パーサ)で symbols/edges 化される。
**multi-stage 構造の参照グラフ**を作る: named stage(`stage.build`)と ARG
(`arg.NODE_VERSION`)がシンボル、`FROM`/`COPY --from`/`RUN --mount=from` のステージ
参照が resolved エッジ、外部ベースイメージは `:tag`/`@digest` を落としたリポジトリ名で
`imports` / `resolved=0`(将来の `links.json` image→repo 宣言の入口、#35)。COPY/ADD の
リテラルソースは存在する場合のみ repo 相対パスで `resolved=0` に残す(後段バインダの
測定対象 — 設計は [`docs/dockerfile-baseline.md`](docs/dockerfile-baseline.md))。
librarian は以下の順でバイナリを探す:

1. `LIBRARIAN_DOCKERFILE_EXTRACTOR` 環境変数(ビルド済みバイナリへのパス)
2. `librarian-dockerfile-extractor` が `$PATH` 上にある(`go build -o <PATHの通った場所>/librarian-dockerfile-extractor ./dockerfile-extractor`)
3. Go toolchain があれば `go run ./dockerfile-extractor` に自動フォールバック

どれも無い場合、Dockerfile はファイルレベルの module シンボルのみに degrade する
(インデックス全体は失敗しない。警告が stderr に出る)。

## Kubernetes マニフェストのインデックス

`.yaml` / `.yml` は Go 製の抽出バイナリ(`k8s-extractor/`、yaml.v3)で symbols/edges
化される。**素のマニフェスト + Kustomize が対象**(Helm template は valid YAML でない
ためファイルレベルに degrade)。k8s の内容判定はプラグイン内(`apiVersion` + `kind` +
`metadata.name` の自己申告)で行うため、**非 k8s YAML(CI 設定等)は module シンボル
のみ・エッジ 0** で無害。Ansible 等の別 YAML 抽出器は `.librarian/extractors.json` で
宣言すればこのビルトインを上書きできる(設計は
[`docs/k8s-baseline.md`](docs/k8s-baseline.md))。librarian は以下の順でバイナリを探す:

1. `LIBRARIAN_K8S_EXTRACTOR` 環境変数(ビルド済みバイナリへのパス)
2. `librarian-k8s-extractor` が `$PATH` 上にある(`go build -o <PATHの通った場所>/librarian-k8s-extractor ./k8s-extractor`)
3. Go toolchain があれば `go run ./k8s-extractor` に自動フォールバック

シンボルは `Deployment/api` / `ConfigMap/api-config`(kind/name)、Kustomization は
`Kustomization/<dir>`。configMap/secret 参照・Ingress backend・Kustomize resources/
patches・一意に決まる Service selector が references/imports エッジになり、`image:` は
tag を落としたイメージ名で `resolved=0`(dockerfile 抽出器と同じ #35 の入口)。

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

**外部インデクサで native 未対応言語を足す**(抽出器を書かずに 1 言語増える)。例: Ruby —

```bash
scip-ruby index <repo> --output index.scip
node bin/librarian.js import index.scip --db <db> --root <repo>
```

native レグのある言語(`.py` など)の外部 index を**あえて優先したい**場合は
`--prefer-scip` を付ける(既定は native 優先。下記 dispatch を参照)。

ext サイドカーの無い `.scip` は degrade 規則で取り込む(設計 §4.5): Import role →
imports、`is_implementation` → extends、残りの参照は一律 references。unresolved は
存在せず、testblock は部分再構成。native との差の実測(= ext の価値)は
[`docs/scip-baseline.md`](docs/scip-baseline.md)(scip-python: micro recall 88.1%)。

**dispatch 優先度 — native が常に勝つ**(設計 §4.5): degrade `.scip` 内のドキュメントの
うち、native extractor が claim する拡張子(`.ts`/`.js`/`.go`/`.php`/`.py`/`.tf` …)のものは
スキップされる(レポートの `skippedNativeFiles`)— それらの言語は `librarian index` が
richer な取り込み口。ext サイドカー付き(`librarian export --scip` の出力)は native
信号そのものなのでスキップされない。`index` と `import` はファイル削除の管轄を
「自分が扱う拡張子」に限定するため、**同一 db・同一 repo で共存できる**
(例: TS は native インデックス、Ruby は scip-ruby の import)。

この既定を**明示的に**降ろすのが `import --prefer-scip`(#6 で追加): native レグができた後も
外部インデクサの推論を使いたいときのオプトアウト。既定は変わらない — 黙って外部行が
native 行を置き換えることはない。native と外部の実測比較は
[`docs/python-baseline.md`](docs/python-baseline.md)。

## 抽出器プラグイン(issue #22 / ADR-7)

抽出器は**プロトコル準拠のプラグイン**。TS は in-process(TS Compiler API)、Go/PHP/Python/
Terraform はプロトコルのリファレンスプラグイン(子プロセス — コンパイル型とインタプリタ型の
両方の実例)。第三者は**コードを書き換えずに**新言語プラグインを足せる — 契約の全文は
[`docs/plugin-protocol.md`](docs/plugin-protocol.md)。

**ワイヤ契約**: 子プロセスは `{root, files}` JSON を stdin で受け、SCIP+ 封筒 `{scip, ext}` を
stdout に出す(protobuf 非依存。封筒スキーマは [`src/protocol/scip-plus.schema.json`](src/protocol/scip-plus.schema.json)、
moniker 文法は [`docs/scip-design.md`](docs/scip-design.md) §4.2)。`--capabilities` で
`{protocol, protocolVersion, name, extensions}` を返してバージョン交渉に応じる。

**レジストリ** `.librarian/extractors.json`(拡張子→コマンドの明示宣言):

```jsonc
{
  "version": 1,
  "extractors": [
    { "name": "librarian-rust", "extensions": [".rs"], "command": "librarian-rust-extractor", "args": [] }
  ]
}
```

`command` は PATH 上の名前・絶対パス・repo ルート相対パスのいずれか。宣言が同一拡張子の
ビルトインを**上書き**する(例: `.go` を自前ビルドに差し替え)。宣言が無ければビルトイン
(TS/Go/PHP)だけで従来どおり動く。

**信頼モデル**: プラグイン = 任意コマンドの実行。**明示登録のみ・自動ダウンロード無し・
PATH 規約による暗黙発見なし**。`.librarian/extractors.json` は repo にコミットされ、
「このリポジトリは何を実行するか」が PR でレビューでき git 履歴に残る — サンドボックスは
しないので、third-party プラグインの登録はそのコマンドに repo とマシンを預けることを意味する。

**適合性(conformance)**: `eval/fixtures/<lang>-taskflow` + `eval/golden/<lang>-taskflow.json` を
用意し `librarian eval` が green になれば適合。既存 Go/PHP はレジストリ経由でも eval 完全一致。

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

- `index` / `import` が最後に出す summary は **per-repo**(#29): `symbols` / `edges` /
  `unresolvedEdges` はその run の repo の行数であって db 全体の累計ではない
  (`filesSeen` / `filesIndexed` と集計単位が揃う)。db 全体の内訳は `stats` を見る。
- diff 系(`retrieve`/`pack`/`review`/`eval`)はソース本文を repos テーブルの root から
  読む。同じ相対パスが複数 repo にある場合は `--repo <name>` で diff の属する repo を
  指定する。インデックス時と root が移動した場合は `--root <dir>` で上書き。
- v2 より前の db は開けない(再インデックスを案内するエラーになる)。
- リポジトリ間の import は抽出だけでは解決できないため、既定では `resolved = 0` のまま
  隔離される。繋ぐには次の `librarian link` で **package 名 → repo を明示宣言**する。

## リポジトリ間 import の解決 — `librarian link`(issue #27 / ADR-8)

「`@acme/core` という指定子は、隣にインデックスしたあの repo のことだ」— この 1 つの事実は
どちらのツリーにも書かれていない。宣言として渡すと、抽出器が開けたまま残したエッジが
繋がる。

```jsonc
// .librarian/links.json(db の隣。--map <file> で任意の場所を指定可)
{ "packages": [ { "package": "@acme/core", "repo": "acme-core", "entry": "src/index.ts" } ] }
```

```bash
node bin/librarian.js index ~/src/acme-core --db shared.db --repo-name acme-core
node bin/librarian.js index ~/src/acme-app  --db shared.db --repo-name acme-app
node bin/librarian.js link --db shared.db --dry-run --pretty   # 何が繋がるかを先に見る
node bin/librarian.js link --db shared.db                      # {"newlyResolved":14,...}
node bin/librarian.js link --db shared.db --clear              # 抽出直後の状態に戻す
```

繋がった後は `graph` / `pack` / `review` が repo を跨いで近傍を展開する(retrieval 側に
repo の特別扱いは無い — 普通の resolved エッジとして辿るだけ)。

- **宣言が無ければ何も起きない**。link 未実行なら cross-repo エッジは 0 本で、
  graph/pack/eval の結果は #27 以前と同一(TS golden の micro recall 87.0% は不変)。
- **推測しない**。call site の名前は、そのファイルが宣言済み package から**実際に binding
  している**場合にだけ束縛される(抽出器が `imports @acme/core#createTask` として記録する)。
  対象 repo に同名の module-scope 宣言が複数あれば繋がず `ambiguous` として報告する。
- **冪等・可逆**。2 回目の link は何も足さない。`--clear` は抽出器が吐いた行に戻す。
- メソッド呼び出し・default/namespace import・宣言のない package は `resolved = 0` のまま
  (型解決が要るものは繋がない)。binding を吐くのは現状 TS 抽出器のみ(他言語は
  `docs/plugin-protocol.md` §8.1 の規約で opt-in 可能)。
- `index` は変更ファイルのエッジを作り直すため、その cross-repo エッジは unresolved に戻る。
  CI では **index → link** を 1 セットにする。

数値(同一 golden・link の有無だけを変えた A/B): micro recall **0.429 → 1.000**
— `docs/cross-repo-baseline.md`、fixture は `eval/fixtures/cross-repo/`。

## フレームワーク規約の動的ディスパッチ — `librarian resolve-dispatches`(issue #43 / ADR-9)

CakePHP の `$this->redirect(['controller'=>'Foo','action'=>'bar'])` は「次に `FooController::bar`
を実行する」という**遷移**だが、`'bar'` が `bar()` を指すのは PHP の文法ではなくフレームワークの
実行時規約であり、汎用パーサは関知しない。結果として画面遷移フローがグラフに存在しない。

PHP 抽出器はこの遷移を新エッジ種別 `dispatches`(`resolved=0`、`dispatch <controller>#<action>`)
として**事実だけ**記録し、`resolve-dispatches` が CakePHP の命名規約
(`['controller'=>'Foo']` → クラス `FooController`、`['action'=>'bar']` → その public メソッド)で
束縛する(`link` と同型の二段構え)。

```bash
node bin/librarian.js index ~/src/my-cake-app --db idx.db
node bin/librarian.js resolve-dispatches --db idx.db --dry-run --pretty  # 何が繋がるかを先に見る
node bin/librarian.js resolve-dispatches --db idx.db                     # {"newlyResolved":4,...}
node bin/librarian.js resolve-dispatches --db idx.db --clear             # 抽出直後の状態に戻す
```

- **推測ではなく規約**。規約対象が存在しなければ `resolved=0` のまま(`missingTargets` に報告)、
  同名 controller クラスが複数ファイルにあれば繋がず `ambiguous` として拒否する。
- **リテラル文字列のみ**。変数・式で addressing された controller/action(`redirect($url)` 等)は
  静的に解決不能なので抽出器がそもそも吐かない(スコープ外)。
- **冪等・可逆**。2 回目は何も足さない。`--clear` は抽出器が吐いた unresolved 行に戻す。
- 検出は現状 PHP(CakePHP redirect/setAction)のみ。エッジ種別と後段の骨格は言語非依存で、
  他フレームワークは `docs/plugin-protocol.md` §8.2 の規約で opt-in できる。
- `index` は変更ファイルのエッジを作り直すため resolved dispatch は unresolved に戻る。
  CI では **index → resolve-dispatches** を 1 セットにする。

数値(同一 golden・resolve の有無だけを変えた A/B): micro recall **0.273 → 1.000**
— `docs/dispatch-baseline.md`、fixture は `eval/fixtures/cake-taskflow/`。

## LLM プロバイダの選択(issue #42 / ADR-10)

LLM を使う 2 機能(`librarian review`、Web の「司書に聞く」)は、プロバイダ抽象
(`src/llm/`)経由で LLM を呼ぶ。既定は Anthropic 公式 API で、**従来どおり
`ANTHROPIC_API_KEY` だけで動く**(設定はそれで完了)。

Anthropic 公式 API に直接到達できない環境(プロキシ/ゲートウェイ経由必須の組織など)では、
OpenAI 互換の chat-completions エンドポイントを env で明示指定できる:

```bash
LLM_PROVIDER=anthropic            # 既定。ANTHROPIC_API_KEY を使う
# または
LLM_PROVIDER=openai-compatible
LLM_OPENAI_COMPATIBLE_BASE_URL=…  # API ルート(通常 /v1 で終わる)。/chat/completions を付けて呼ぶ
LLM_OPENAI_COMPATIBLE_API_KEY=…   # Authorization: Bearer で送る(不要なら未設定で可)
LLM_MODEL=…                       # モデル名。openai-compatible では必須(既定モデルを持たない)
```

- **明示選択のみ・暗黙フォールバックなし**(抽出器レジストリ ADR-7 と同じ信頼モデル)。
  未知の `LLM_PROVIDER` はエラーになり、別プロバイダへ勝手に切り替わることはない。
- モデル指定の優先度は `--model`(review のみ)> `LLM_MODEL` > `LIBRARIAN_MODEL`
  (後方互換エイリアス)> プロバイダ既定(anthropic のみ)。
- 構造化出力(review の JSON findings)は、ネイティブのスキーマ強制が無いプロバイダでは
  JSON Schema を system prompt に埋め込んで応答をパースする(フェンス許容)。パース失敗は
  リトライせず型付きエラーで表面化する。
- 特定ベンダーのゲートウェイ名・URL はコードにもドキュメントにも持ち込まない — base URL は
  利用者の環境の値をそのまま渡す。
- 設定の検証は `librarian review <diff> --dry-run` が便利(実際の呼び出しをせずに
  provider / model の解決結果を表示する)。
