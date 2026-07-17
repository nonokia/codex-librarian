# Dockerfile 抽出器ベースライン — issue #40 (ADR-2 多言語パス)

日付: 2026-07-17 / 対象: `eval/fixtures/dockerfile-taskflow`(Dockerfile 3 形式 + TS 2 files /
14 symbols / 20 edges, うち unresolved 11 — COPY ソースと外部イメージは設計上 unresolved)/
正解セット: `eval/golden/dockerfile-taskflow.json`(5 ケース)

## 何を作ったか

`Extractor` インターフェースの Dockerfile 実装。抽出本体は `dockerfile-extractor/`
(Go 製の小さなバイナリ、**BuildKit 自身の Dockerfile フロントエンド**
`moby/buildkit/frontend/dockerfile` = 公式実装そのもの)で、Terraform/SQL と同じ
subprocess プラグイン(ADR-7)として子プロセスで呼ぶ。**multi-stage 構造の参照グラフ**
(call graph ではない)。

**ルーティング(この issue の設計点)**: `Dockerfile` は拡張子を持たないため、
`Extractor` に任意の **`claims(relPath)` 述語**を追加した(拡張子サフィックス一致を
置き換える)。ビルトインの Dockerfile leg は `Dockerfile` / `Dockerfile.*` /
`*.dockerfile` の 3 形式を claim する。ADR-7 の信頼モデル(明示登録のみ・規約発見なし)
は不変 — claims も明示登録された抽出器の静的宣言である。`--capabilities` は
`basenames` フィールドでこのパターンを申告する(未知フィールドは無視される)。

- symbols:
  - named build stage → `stage.build`(kind **stage**、SCIP は未使用の `Package` に写像)
  - `ARG` → `arg.NODE_VERSION`(kind variable、既存を再利用。グローバル/ステージ内とも)
  - ファイル自体は module シンボル。無名ステージはシンボルを持たず file module から参照する。
- edges:
  - `FROM <prior stage>` / `COPY --from=<stage|index>` / `RUN --mount=from=<stage>` →
    同一ファイル内の named stage に解決(`references`、大文字小文字非依存)。
  - 外部ベースイメージ → **`imports` / `resolved=0`**。toName は `:tag`/`@digest` を
    落とした**イメージリポジトリ名**(`node:${V}-alpine` → `node`)— タグはバージョンで
    あり、`links.json` の image→repo 宣言(#35)が名指すのはリポジトリ identity という
    整理。リポジトリ部分自体に変数がある場合のみ emit しない。
  - `COPY`/`ADD` のリテラルソース → 存在確認(Dockerfile のディレクトリ → repo root の
    順 = 2 つの一般的な build context)の上で **`references` / `resolved=0` + repo 相対
    パス**。glob は生パターンのまま resolved=0、`$` を含む/存在しないソースは emit
    しない(一意に存在する場合のみ張る、issue #40)。
  - `${ARG}` の使用行 → 宣言済み ARG への `references`(使用行を含むステージから)。
    未宣言の `$VAR` はシェル/環境変数ノイズなので emit しない。
  - `ONBUILD` は内側の命令を再パースして同じ規則で処理。

**COPY ソースが resolved=0 なのは意図的な設計**(dlog 記録): 抽出器の出力 id は
`namespaceIds` で**抽出器の実行単位ごとに** repo 名前空間化されるため、extract 時に
他抽出器のファイル module 行へ resolved エッジを張っても必ず dangling になる。
unresolved + 正規化パスで正直に残し、link(ADR-8)型の後段バインダの入口とする。

## ベースライン(hops=2, budget=8000, 既定戦略 — 全言語と同一)

| 指標 | 値 |
|---|---|
| ケース数 | 5(すべて target 式) |
| **micro recall** | **90.9%**(10/11) |
| macro recall | 90% |
| 完全一致ケース | 4/5 |
| 平均取得 items / chars | 3.6 / 294 |

**唯一のミスは df-005 の「COPY されるソース変更 → Dockerfile」**で、上記の設計判断に
より現行実装では構造的に辿れない。eval/README.md の規律(取れない expected を削らない —
その差分が改善対象そのもの)に従い golden に残し、テストは 10/11 を**固定値として
ロック**している。stage / ARG の blast radius(multi-stage の本体)は全回収。

## 検証(受け入れ条件)

`stage.deps` を変更する diff → `pack` の「関連コード」に `stage.build` が載る
(依存インストールの変更がビルドステージを文脈として引き込む)。`Dockerfile` /
`Dockerfile.worker` / `proxy.dockerfile` の 3 命名形式がすべてルーティングされ、
TS ファイルと同一 index に共存する(`src/test/extractor-dockerfile.test.ts`)。

## 再現手順

```bash
npm run build
go build -o /tmp/librarian-dockerfile-extractor ./dockerfile-extractor
LIBRARIAN_DOCKERFILE_EXTRACTOR=/tmp/librarian-dockerfile-extractor \
  node dist/cli.js index eval/fixtures/dockerfile-taskflow --db /tmp/dftf.db
node dist/cli.js eval eval/golden/dockerfile-taskflow.json --db /tmp/dftf.db --pretty
```
