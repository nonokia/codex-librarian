# Kubernetes マニフェスト抽出器ベースライン — issue #39 (ADR-2 多言語パス)

日付: 2026-07-17 / 対象: `eval/fixtures/k8s-taskflow`(8 files / 18 symbols / 21 edges,
うち unresolved 2 = image 参照のみ)/ 正解セット: `eval/golden/k8s-taskflow.json`(5 ケース)

## 何を作ったか

`Extractor` インターフェースの k8s マニフェスト実装。抽出本体は `k8s-extractor/`
(Go 製の小さなバイナリ、yaml.v3)。**素のマニフェスト + Kustomize が v1 スコープ**、
Helm template は対象外(Go template 混じりの `templates/*.yaml` は valid YAML でなく
パース失敗 → ファイルレベルに degrade。偽エッジより欠落、architecture §8 risk 2)。

**ルーティング(#37 と共有の設計判断、dlog 記録)**: この抽出器はビルトインとして
汎用の `.yaml`/`.yml` を claim し、**k8s の内容判定はプラグインの中に置く** —
k8s ドキュメントは `apiVersion` + `kind` + `metadata.name` で自己申告するため判定は
決定的で、非 k8s YAML(CI 設定等)は module シンボルのみ・エッジ 0 で無害。
Ansible(#37)には自己申告が無いため `.librarian/extractors.json` での **opt-in** とし、
宣言した repo ではレジストリの優先規則でこのビルトインを上書きする。ADR-7 の
明示登録モデルは不変。

- symbols(kind は Terraform の `resource` を**再利用** — 宣言されたリソースという
  同一概念に新 kind を増やさない):
  - 各 `---` ドキュメント → `Deployment/api` / `ConfigMap/api-config`(kind/name。
    非 default namespace は `ns/kind/name`、両形で引ける)
  - Kustomization ドキュメント → `Kustomization/<dir>`(metadata.name を持たない
    ことが多いためディレクトリで命名)
  - `configMapGenerator` / `secretGenerator` → 生成される `ConfigMap/<name>` 等を宣言
  - ファイル自体は module シンボル
- edges:
  - `configMapRef` / `configMapKeyRef` / `secretRef` / `secretKeyRef` / volume の
    `configMap:` `secret:` → **名前による事実参照**(references)
  - Ingress の `backend.service.name` → Service
  - Kustomize の `resources:` / `patches:` → 対象ファイルの **document シンボル**
    (imports。ディレクトリは配下ファイルに展開、ドキュメントの無いファイルは module に
    フォールバック)。file module でなく document へ張るのは (1) kustomize が合成する
    のは resource であり (2) retrieval は document を seed し module を fallback 扱い
    するため — module 同士のエッジは展開に見えない(初版は 47% → この形で 100%。
    dlog 記録)
  - Service の `spec.selector` → **template labels が selector を包含する workload が
    ちょうど 1 つのときだけ**解決。複数/0 件は `selector:k=v` の正規形で resolved=0
    (曖昧なら繋がない — link / resolve-dispatches と同じ原則)
  - `image:` → `imports` / resolved=0。toName は tag/digest を落としたリポジトリ名で、
    **dockerfile 抽出器と同じ #35 specifier**(`links.json` の image→repo 宣言で将来
    束ねる入口)

## ベースライン(hops=2, budget=8000, 既定戦略 — 全言語と同一)

| 指標 | 値 |
|---|---|
| ケース数 | 5(すべて target 式) |
| **micro recall** | **100%**(19/19) |
| macro recall | 100% |
| 完全一致ケース | 5/5 |
| 平均取得 items / chars | 8.0 / 1,907 |

k8s の参照は名前による事実参照が中心のため、参照グラフが blast radius をそのまま含む
(Terraform / SQL と同じ注意書き: 小さな整った fixture での証明であり、精度一般の主張
ではない)。実運用形(Helm、多 namespace、CRD)での計測は正解セットの成長と合わせて
次の課題。

## 検証(受け入れ条件)

`ConfigMap/api-config` を変更する diff → `pack` の「関連コード」に envFrom で読む
`Deployment/api` と volume で読む `Deployment/worker` が載る。selector の曖昧ケース
(同一 labels の workload 2 つ)は resolved=0 に留まる。GitHub Actions YAML と Helm
template は module のみ・エッジ 0 に degrade(いずれも `src/test/extractor-k8s.test.ts`)。

## 再現手順

```bash
npm run build
go build -o /tmp/librarian-k8s-extractor ./k8s-extractor
LIBRARIAN_K8S_EXTRACTOR=/tmp/librarian-k8s-extractor \
  node dist/cli.js index eval/fixtures/k8s-taskflow --db /tmp/k8stf.db
node dist/cli.js eval eval/golden/k8s-taskflow.json --db /tmp/k8stf.db --pretty
```
