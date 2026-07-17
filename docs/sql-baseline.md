# SQL 抽出器ベースライン — issue #36 (ADR-2 多言語パス)

日付: 2026-07-17 / 対象: `eval/fixtures/sql-taskflow`(7 files / 20 symbols / 19 edges,
うち unresolved 0)/ 正解セット: `eval/golden/sql-taskflow.json`(6 ケース)

## 何を作ったか

`Extractor` インターフェースの SQL 実装。抽出本体は `sql-extractor/`(Go 製の小さな
バイナリ、libpg_query = **PostgreSQL サーバ本体のパーサをライブラリ化したもの** を
pganalyze/pg_query_go 経由で使用)で、librarian は Go/Terraform と同じ subprocess
プラグイン(ADR-7)として子プロセスで呼ぶ(stdin: `{root, files}` / stdout: SCIP+ 封筒
`{scip, ext}`)。store・retrieval・UI は行がどの言語から来たかを知らない。

**call graph ではなくリレーション/ルーチン参照グラフ**である点で Terraform と同型。
SQL は宣言(CREATE ...)と参照(FROM / JOIN / FOREIGN KEY / EXECUTE FUNCTION)が
字句的に明示されるため、**構文レベルの解析で十分** — ADR-2 の「型解決必須」は call
graph 言語向けの判断であり SQL には当てはまらない(この解釈は dlog に記録)。

**方言は Postgres のみ**(v1)。単一の公式 SQL パーサは存在しないため、「公式実装
ベース」(ADR-2)に最も忠実な libpg_query を積み、方言は `--capabilities` の
`dialect: "postgresql"` で申告する。**パースできないファイル(他方言・テンプレート
SQL)はファイルレベル module symbol に degrade** し、偽エッジは作らない(architecture
§8 risk 2 = 偽エッジより欠落)。

- symbols: すべて参照アドレスで命名(エッジ解決がその名の文字列一致になる。
  非 public スキーマは修飾を保持):
  - `CREATE TABLE users` → `table.users`(kind **table**)
  - `CREATE VIEW active_tasks` → `view.active_tasks`(kind **view**)
  - `CREATE MATERIALIZED VIEW stats` → `matview.stats`(kind **matview**)
  - `CREATE FUNCTION f()` → `function.f`(kind function、既存を再利用)
  - `CREATE PROCEDURE p()` → `procedure.p`(kind **procedure**)
  - `CREATE TRIGGER tr ON t` → `trigger.tr`(kind **trigger**)
  - `CREATE INDEX i ON t` → `index.i`(kind **index**)
  - ファイル自体は module シンボル(name === file)。
- edges(すべて `references`):
  - view / matview → クエリが FROM/JOIN するリレーション
  - FOREIGN KEY(列制約・テーブル制約・ALTER TABLE ADD CONSTRAINT)→ 参照先テーブル
  - trigger → ON のリレーション + EXECUTE FUNCTION のルーチン
  - index → ON のリレーション
  - function / procedure 本体 → 触るリレーション。3 段階のパース可能性:
    1. `BEGIN ATOMIC`(sql_body)— パース済みの木をそのまま辿る
    2. `LANGUAGE sql AS $$...$$` — 本体文字列を再パース
    3. `LANGUAGE plpgsql` — `ParsePlPgSqlToJSON` で埋め込み query 文字列を取り出し
       best-effort 再パース(パースできない断片は捨てる。推測しない)
  - migration の ALTER / DML はファイル module(または同一ファイル内の定義シンボル)
    から対象リレーションへの参照。**複数 migration の畳み込み(最終スキーマ合成)は
    しない** — ファイル単位の宣言と参照をそのまま吐く(決定性優先、issue #36)。
  - repo 内に定義が無いリレーション/ルーチンは `resolved=0` + 生名
    (measurability over completeness)。

新 kind の SCIP+ 契約: table→`Type` / view→`Delegate` / matview→`Instance` /
procedure→`Macro` / trigger→`Event` / index→`Key`(いずれも既存 `KIND_TO_SCIP`
未使用で全単射を維持)。module / function は既存の写像を再利用。

## ベースライン(hops=2, budget=8000, 既定戦略 — 全言語と同一)

| 指標 | 値 |
|---|---|
| ケース数 | 6(すべて target 式) |
| **micro recall** | **100%**(26/26) |
| macro recall | 100% |
| 完全一致ケース | 6/6 |
| 平均取得 items / chars | 10.8 / 2,171 |

SQL は参照が字句的に明示されるため、参照グラフが blast radius をそのまま含む。**これは
「SQL 抽出器のグラフが retrieval にそのまま機能する」ことの証明であって、SQL での精度
一般の主張ではない**(対象はこの issue のために書いた小さな整った fixture。Terraform
ベースラインと同じ注意書き)。実マイグレーション履歴(同一テーブルへの CREATE/ALTER が
多数のファイルに散る形)での計測は正解セットの成長と合わせて次の課題。

## 検証(受け入れ条件)

`table.users` を変更する diff → `pack` の「関連コード」に FK で依存する
`table.tasks` が `←references` で載る = テーブル変更が依存オブジェクトを文脈として
引き込む。trigger 関数(plpgsql)の本体参照も 1-hop で辿れる(`function.log_task_change`
→ `table.task_events`)。他方言ファイル(MySQL 風 DDL)は module symbol に degrade し
偽エッジを作らない(いずれも `src/test/extractor-sql.test.ts`)。

## 再現手順

```bash
npm run build
go build -o /tmp/librarian-sql-extractor ./sql-extractor   # または go install ./sql-extractor
LIBRARIAN_SQL_EXTRACTOR=/tmp/librarian-sql-extractor \
  node dist/cli.js index eval/fixtures/sql-taskflow --db /tmp/sqltf.db
node dist/cli.js eval eval/golden/sql-taskflow.json --db /tmp/sqltf.db --pretty
```
