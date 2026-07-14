# Terraform (HCL) 抽出器ベースライン — issue #9 (ADR-2 多言語パス)

日付: 2026-07-14 / 対象: `eval/fixtures/terraform-taskflow`(10 files / 36 symbols / 41 edges,
うち unresolved 0)/ 正解セット: `eval/golden/terraform-taskflow.json`(7 ケース)

## 何を作ったか

`Extractor` インターフェースの Terraform (HCL) 実装。抽出本体は `tf-extractor/`(Go 製の
小さなバイナリ、`hashicorp/hcl` = Terraform 公式パーサ)で、librarian は Go/PHP と同じ
subprocess プラグイン(ADR-7)として子プロセスで呼ぶ(stdin: `{root, files}` / stdout:
SCIP+ 封筒 `{scip, ext}`)。store・retrieval・UI は行がどの言語から来たかを知らない。

**call graph ではなくリソース/モジュール参照グラフ**である点で他言語と性質が異なる。
HCL は動的ディスパッチがなく参照が字句的に明示される(`var.x` / `module.y.out` /
`aws_x.y.attr`)ため、**構文レベルの解析で十分** — ADR-2 の「型解決必須」は call graph
言語向けの判断であり HCL には当てはまらない(この解釈は dlog に記録)。

HCL パーサ方式(hand-written TS / Go バイナリ / tree-sitter)は Go バイナリ(hashicorp/hcl)
を採用。パース堅牢性が最高で、Go/PHP と同じ subprocess プロトコルに載る。

- symbols: すべて Terraform の参照アドレスで命名(エッジ解決がその名の文字列一致になる):
  - `resource "aws_instance" "web"` → `aws_instance.web`(kind **resource**)
  - `data "aws_ami" "ubuntu"` → `data.aws_ami.ubuntu`(kind **data**)
  - `variable "region"` → `var.region`(kind variable、既存を再利用)
  - `output "ip"` → `output.ip`(kind **output**)
  - `module "vpc"` → `module.vpc`(kind module、既存を再利用)
  - `locals { tags = ... }` → `local.tags`(kind **locals**、locals ブロックの各属性が
    独立したシンボル)
  - ファイル自体は module シンボル(name === file)。**module ブロックとファイルは kind
    (どちらも module)ではなく moniker で区別する**(bare file head vs term descriptor)。
- edges:
  - references: `var.*` / `local.*` / リソース属性参照 / `module.*.output` /
    `data.*` / `depends_on`(すべて `references`)。参照は `expr.Variables()` で
    抽出(補間 `${}`・for 式・関数呼び出しの中も網羅)。
  - imports: `module "x" { source = ... }` — ローカル相対 source は対象ディレクトリの
    .tf ファイル module に解決、registry/remote は `resolved=0` + 生の source 文字列。
  - provider / registry / 未知参照は `resolved=0` + 生名(measurability over completeness)。

新 kind の SCIP+ 契約: resource→`Object` / data→`Value` / output→`Property` /
locals→`Constant`(いずれも既存 `KIND_TO_SCIP` 未使用で全単射を維持)。module ブロックは
`module → File` を再利用し、moniker(descriptor の有無)で file シンボルと区別する。

## ベースライン(hops=2, budget=8000, 既定戦略 — 全言語と同一)

| 指標 | 値 |
|---|---|
| ケース数 | 7(すべて target 式) |
| **micro recall** | **100%**(26/26) |
| macro recall | 100% |
| 完全一致ケース | 7/7 |
| 平均取得 items / chars | 10.3 / 1,893 |

HCL は参照が字句的に明示されるため、参照グラフが blast radius をそのまま含む。**これは
「Terraform 抽出器のグラフが retrieval にそのまま機能する」ことの証明であって、HCL での
精度一般の主張ではない**(対象はこの issue のために書いた小さな整った fixture)。実 OSS
リポジトリでの計測は正解セットの成長と合わせて次の課題(この環境からは外部リポジトリを
取得できないため、対象リポジトリは fixture をコミットする形にした)。issue #9 が予期した
とおり、「diff が触れたブロックの blast radius をレビューに渡す」graph-first の価値は
HCL で最も分かりやすく出る。

## 検証(受け入れ条件)

`var.instance_count` を変更する diff → `pack` の「関連コード」に `aws_instance.web`
(resource)が `←references` で載る = variable の変更が影響先 resource を文脈として
引き込む(issue #9 の受け入れ条件)。SCIP+ export → import の round-trip でも module
ブロック・新 kind が保存される(native 経路、`degraded=false`)。

## 再現手順

```bash
npm run build
go build -o /tmp/librarian-tf-extractor ./tf-extractor   # または go install ./tf-extractor
LIBRARIAN_TF_EXTRACTOR=/tmp/librarian-tf-extractor \
  node dist/cli.js index eval/fixtures/terraform-taskflow --db /tmp/ttf.db
node dist/cli.js eval eval/golden/terraform-taskflow.json --db /tmp/ttf.db --pretty
```
