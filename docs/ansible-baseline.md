# Ansible 抽出器ベースライン — issue #37 (ADR-2 多言語パス)

日付: 2026-07-17 / 対象: `eval/fixtures/ansible-taskflow`(9 files / 24 symbols / 13 edges,
うち unresolved 3 = Galaxy role・未定義変数・template パス)/ 正解セット:
`eval/golden/ansible-taskflow.json`(5 ケース)

## 何を作ったか

`Extractor` インターフェースの Ansible 実装。抽出本体は `ansible-extractor/extract.py`
(**PyYAML のみ**に依存する Python スクリプト。py-extractor と同じインタプリタ実行・
ビルド不要)。汎用 YAML 抽出ではなく **Ansible のディレクトリ規約・キーワードを知って
いる専用抽出器**。ansible-core の loader は「公式実装ベース」に最も忠実だが、全 indexing
環境に ansible 依存を持ち込むため不採用(必要な規約知識は小さく安定 — dlog 記録)。
`--capabilities` は `parser: "pyyaml"` を申告し、PyYAML 不在時は module-only 出力 +
stderr 警告に degrade する(index 全体は失敗しない)。

**ルーティング(#39 と共有の設計判断)**: Ansible YAML には k8s の `apiVersion`+`kind` の
ような自己申告が無いため、**ビルトインにせず `.librarian/extractors.json` での opt-in**
とする。宣言した repo ではレジストリの優先規則で k8s ビルトインを上書きする(ADR-7 の
明示登録モデル)。fixture の宣言が参照例:

```json
{ "version": 1, "extractors": [
  { "name": "librarian-ansible", "extensions": [".yml", ".yaml"],
    "command": "librarian-ansible-extractor", "args": [] } ] }
```

(`command` は PATH 上のラッパ名でも、repo 相対の `extract.py` パスでもよい。
`extract.py` は shebang + 実行ビット付きなので symlink で PATH に置ける。)

- symbols(ディレクトリ規約から):
  - play → `play.<name>`(kind resource — 状態を宣言する単位)
  - named task / handler → `task.<name>` / `handler.<name>`(kind function。無名 task は
    シンボル化せず、包含する play / role / module から参照する)
  - 変数定義 → `var.<name>`(kind variable。`defaults/` `vars/` `group_vars/`
    `host_vars/` ファイルのトップレベルキー)
  - role → `role.<name>`(kind module、`roles/<r>/tasks/main.yml` にアンカー — tf の
    module ブロックと同じく moniker でファイルシンボルと区別)
  - ファイル自体は module シンボル
- edges:
  - play の `roles:` / `include_role` / `import_role` → role シンボル。repo に無い
    Galaxy role は **resolved=0 + 生の名前**(将来の requirements.yml → repo 宣言
    (#35)の specifier)
  - `notify` → `handler.<name>`
  - `include_tasks` / `import_tasks` / `import_playbook` → 対象ファイルの module
    (imports、claimed set 内で解決)
  - `template:` の src → 存在する場合のみ repo 相対パスで resolved=0(`.j2` は
    unclaimed — dockerfile COPY ソースと同じ規則)
  - `{{ var }}` → 先頭の単純識別子を定義済み変数に解決。**ランタイム組み込み
    (`item` / `ansible_*` / `hostvars` / `groups` / `lookup` 等)は emit しない**、
    それ以外の未定義名は `var.<name>` で resolved=0 — 「動的な部分は解かず正直に
    残す」(issue #37)をノイズなしで実装
  - play 直下の scalar walk は tasks/handlers セクションを剪定してから行う
    (task 自身の精密なエッジと二重にならない)

## ベースライン(hops=2, budget=8000, 既定戦略 — 全言語と同一)

| 指標 | 値 |
|---|---|
| ケース数 | 5(すべて target 式) |
| **micro recall** | **100%**(5/5) |
| macro recall | 100% |
| 完全一致ケース | 5/5 |
| 平均取得 items / chars | 3.0 / 323 |

fixture は playbook 2 + role 2 + group_vars の最小構成。Terraform/SQL/k8s と同じ
注意書き — 小さな整った fixture 上の証明であり、実運用の複雑さ(dynamic includes、
inventory プラグイン、collection 依存)での精度一般の主張ではない。

## 検証(受け入れ条件)

`var.api_port`(defaults)を変更する diff → `pack` に `{{ api_port }}` を使う
`task.Deploy app config` が載る。opt-in が無い repo では同じ playbook が k8s
ビルトインに落ち、自己申告ゲートにより module のみ・エッジ 0(#39 の設計どおり)。
Galaxy role・未定義変数・template パスは resolved=0 に留まる
(`src/test/extractor-ansible.test.ts`)。

## 再現手順

```bash
npm run build
# fixture は committed .librarian/extractors.json で opt-in 済み
node dist/cli.js index eval/fixtures/ansible-taskflow --db /tmp/anstf.db
node dist/cli.js eval eval/golden/ansible-taskflow.json --db /tmp/anstf.db --pretty
```
