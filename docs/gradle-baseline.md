# Gradle 抽出器ベースライン — issue #38 (ADR-2 多言語パス)

日付: 2026-07-17 / 対象: `eval/fixtures/gradle-taskflow`(6 files / 16 symbols / 19 edges,
うち unresolved 11 = 外部座標・プラグイン id・未宣言 task — すべて設計上)/ 正解セット:
`eval/golden/gradle-taskflow.json`(5 ケース)

## 何を作ったか

`Extractor` インターフェースの Gradle 実装。抽出本体は `gradle-extractor/`(Go 製の
小さなバイナリ)。**対象はビルドスクリプトの宣言と参照(ビルドグラフ)であり、
Groovy/Kotlin の汎用コード解析はしない** — Terraform と同じ「構文レベルで十分」の整理。

**issue #38 が最初に判断せよとした論点の結論(dlog 記録): Tooling API は不採用、
構文レベル v1。** Tooling API は公式実装だが対象ビルドを実際に評価する(プラグイン
解決・依存ダウンロード・スクリプト実行)= 実行間・環境間で非決定的で、決定性の
不変条件(ADR-4 の計測規律が乗る土台)と両立しない。必要な宣言サブセット
(`include` / `project(":x")` / task 宣言と `dependsOn` / プラグイン id / catalog
アクセサ / Maven 座標)は両 DSL とも**文字列リテラルレベル**なので、行/パターン
スキャナで決定的に取れ、JVM 不要でインデックスできる。動的な記述(ループでの依存
宣言・計算された座標・convention plugin)は **resolved=0 で正直に残す**。
`gradle/libs.versions.toml` は TOML として**正確にパース**する(BurntSushi/toml)。

- ルーティング: `*.gradle` / `*.gradle.kts` + **`gradle/libs.versions.toml` だけ**を
  `claims` 述語(#40 の機構)で claim(`.toml` 全部を claim すると Cargo.toml /
  pyproject.toml を飲み込む)。
- symbols(新 kind なし):
  - `project.<:path>`(kind **resource** — 各 build.gradle(.kts) にアンカー、パスは
    ディレクトリから導出。module でなく resource なのは #39 の Kustomization の教訓:
    retrieval は module kind を span-overlap の seed にしない。初版 module kind は
    micro 42% → resource で 100%。dlog 記録)
  - `settings`(kind resource — settings ファイル自身のアンカー)
  - `task.<name>`(kind function — 明示宣言のみ: `tasks.register/create`、Groovy `task x {`)
  - `libs.<accessor>` / `libs.plugins.<accessor>`(kind variable — catalog エントリ。
    `-`/`_` は Gradle が生成する `.` アクセサ形に正規化)
- edges:
  - settings `include` → project シンボル(imports)
  - `implementation(project(":core"))`(Kotlin)/ `implementation project(':core')`
    (Groovy)→ `project.:core`(references)
  - 依存 configuration 行の `libs.x` / `alias(libs.plugins.x)` → catalog シンボル
    (references)。catalog エントリ自身 → その座標へ imports/resolved=0
  - `dependsOn` の文字列リテラル → task シンボル(同ファイル → repo 全体の順で解決。
    直近の task コンテキスト(register/create/task/named)に帰属 — 行スキャナは
    brace 木を持たない簡略化、dlog 記録)。未宣言名は resolved=0
  - プラグイン id(`id("...")` / `kotlin("jvm")` → `org.jetbrains.kotlin.jvm` /
    `apply plugin:`)と Maven 座標 → **imports / resolved=0**。座標は version を
    落とした `group:artifact`(image の tag 落としと同じ #35 specifier 流儀)—
    社内ライブラリを別 repo で持つ構成を `links.json` 宣言で将来束ねる入口

## ベースライン(hops=2, budget=8000, 既定戦略 — 全言語と同一)

| 指標 | 値 |
|---|---|
| ケース数 | 5(すべて target 式) |
| **micro recall** | **100%**(12/12) |
| macro recall | 100% |
| 完全一致ケース | 5/5 |
| 平均取得 items / chars | 5.2 / 622 |

catalog をシンボル化する価値が gr-002 に出ている: `libs.commons.text` の変更は
それを catalog 経由で使う `:app` だけに波及し、同じライブラリを座標直書きする
`:worker` は影響外 — この区別は文字列 grep では取れない。他言語と同じ注意書き —
小さな整った fixture 上の証明であり、実運用(buildSrc・convention plugin・
composite build)での精度一般の主張ではない。

## 検証(受け入れ条件)

`:core` のビルド変更 diff → `pack` に Kotlin DSL の `:app` と Groovy DSL の
`:worker`(どちらも `project(":core")` 依存)が載る。`Cargo.toml` / `pyproject.toml`
は claim されない。未宣言 task・外部座標・プラグイン id は resolved=0 に留まる
(`src/test/extractor-gradle.test.ts`)。

## 再現手順

```bash
npm run build
go build -o /tmp/librarian-gradle-extractor ./gradle-extractor
LIBRARIAN_GRADLE_EXTRACTOR=/tmp/librarian-gradle-extractor \
  node dist/cli.js index eval/fixtures/gradle-taskflow --db /tmp/grtf.db
node dist/cli.js eval eval/golden/gradle-taskflow.json --db /tmp/grtf.db --pretty
```
