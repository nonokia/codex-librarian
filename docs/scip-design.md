# SCIP+ 設計 — issue #16(内部交換フォーマットの SCIP 化と拡張レイヤ)

ステータス: **設計文書(実装前)**。architecture.md §9 の手続きに従う ADR 変更提案(§7)を含む。
実装判断は dlog に記録し、各ステップは ADR-4 の回帰ゲート(§6)を通過してから次へ進む。

## 1. 目的と、issue #16 からの差分

issue #16 の B 案(native 抽出器の出力を SCIP 化し、librarian 固有意味論を SCIP+ 拡張として
横付けする)を採用する。ただし設計に先立ち `scip.proto`(2026-07 時点、scip-code/scip)を
仕様レベルで確認した結果、issue の写像表の前提を 2 点修正する必要がある。**本文書はこの
修正を織り込んだ上で二層の役割を再定義したもの**であり、issue 本文より本文書を正とする。

## 2. 仕様確認の結果(設計の前提となる事実)

`scip.proto` を確認して確定した事実。以降の設計はすべてここから導かれる。

**SCIP に写らないもの(= 拡張層が正になるもの):**

1. **calls と references の区別が存在しない。** `SymbolRole` は Definition / Import /
   WriteAccess / ReadAccess / Generated / Test / ForwardDefinition のみで「call」role は無い。
   参照 occurrence が呼び出しか型参照かは原理的に区別できない。librarian の retrieval は
   エッジ種別の重み差(calls 1.0 / extends 0.9 / references 0.7 / imports 0.4)を BFS の
   一次信号にしているため(`src/core/retrieval.ts`)、**エッジ種別の正をベース SCIP に置くことは
   できない**。
2. **未解決参照が表現できない。** `Occurrence.symbol` は Symbol 文法準拠の moniker を要求し、
   「解決できなかった参照」という概念が無い。librarian は `resolved=false`(toId=null,
   toName のみ)のエッジを第一級で持ち(§8-2「完全性より計測可能性」)、`map` の unresolved
   集計にも使う。これも拡張層行き。
3. **testblock 相当の Kind が無い。** `SymbolInformation.Kind` にテストブロックは無く、
   `SymbolRole.Test` は occurrence の属性にすぎない(issue も認識済み)。

**SCIP にあって使える道具:**

- `enclosing_range` — definition occurrence では定義 AST 全域を指す。librarian の行 span の
  写像先として使える。
- `enclosing_symbol` — local symbol の親シンボルを指すためのフィールド。**testblock の
  ネスト連鎖はベース層でもこれで表現できる**(SCIP-only 消費者にも outline として意味を持つ)。
- `Relationship.is_implementation` — extends エッジの忠実な写像先。
- `SymbolRole.Import` — imports エッジの忠実な写像先。
- Descriptor 文法(namespace `/` / type `#` / term `.` / method `().`)— container 連鎖の
  エンコード先。
- bindings — TS: **`@scip-code/scip`**(v0.9.0、依存は `@bufbuild/protobuf` のみ。issue 記載の
  `@sourcegraph/scip` は scip-code org への移管前の旧名)。Go: 公式
  `github.com/scip-code/scip/bindings/go/scip`。PHP: 公式 bindings 無し(→ §4 の JSON 契約で
  protobuf 依存自体を回避)。
- range は `typed_range`(SingleLineRange / MultiLineRange)が推奨形。`repeated int32` は
  deprecated。0-based・half-open。空 range は許容される。

**現行契約側の事実(写像コストの実体):**

- `EdgeRow { fromId, toId, toName, kind, resolved }` は**位置情報を持たない**。SCIP の
  occurrence は位置が主キーなので、native emit には**参照位置の追加取得**が必要になる
  (TS Compiler API / go/packages / php-parser とも参照 ident の位置は保持しており取得可能。
  これは issue に明示されていなかった実装コスト)。
- golden セットは file + symbol 名ベースであり、symbol id スキームの変更には影響されない。
- multi-repo invariant(dlog 宣言済み): extractor は repo を知らない。repo の付与と id の
  名前空間化は indexer の `namespaceIds`(`h20(repo::id)`)が唯一の場所。

## 3. 設計原則(この機能の不変条件)

1. **ext(サイドカー)が retrieval 信号の正。** ベース SCIP は標準準拠の相互運用向け投影で
   あり、native 経路の ingest はベース occurrence からエッジを再導出しない。
2. **ベース SCIP は素の SCIP。** 拡張のためにベースのフィールドを流用・改変しない。
   SCIP-only 消費者はベースだけで意味のある index(定義・参照・outline)を読める。
3. **moniker は repo を含まない。** extractor repo-unaware invariant の延長。repo 次元は
   従来どおり indexer 境界で付与する。
4. **symbol id スキームは維持する。** id は `h20(file::container::name::kind)` →
   `namespaceIds` のまま。moniker は SymbolInformation の属性であって主キーではない。
   moniker の id 化(cross-repo 参照)は要件化した時点の別 ADR。
5. **store スキーマは不変。** SCIP+ は抽出→store 間の契約であり、SQLite スキーマ
   (symbols/edges)には手を入れない(ADR-1 非衝突)。
6. **各ステップは eval 完全一致がゲート。** パイプラインは決定的なので「recall が下がらない」
   ではなく「eval の結果セットが載せ替え前後で完全一致する」ことを要求できる(§6)。

## 4. SCIP+ 契約の定義

### 4.1 全体構造(封筒)

抽出器 → indexer の契約は単一 JSON(SCIP+ 封筒):

```jsonc
{
  "scip": { /* scip.Index の proto3 canonical JSON */ },
  "ext":  { /* §4.4 の拡張スキーマ */ }
}
```

- 子プロセス(go-extractor / php-extractor)の stdout はこの封筒。**protobuf バイナリは
  子プロセス契約に使わない**(php-extractor に protobuf 依存を持ち込まない。Go は
  `protojson`、PHP は手組み JSON で emit)。
- protobuf バイナリ(`.scip` ファイル)の encode/decode は `src/protocol/scip.ts` の 1 箇所に閉じる
  (`@scip-code/scip` + `@bufbuild/protobuf`)。`.scip` が現れるのは export / 外部 import の
  ファイル境界のみ。
- ファイル形式: `<name>.scip`(protobuf、標準準拠)+ `<name>.scip-ext.json`(サイドカー)。
  サイドカー欠落は常に許容(= 外部 .scip の degrade 経路、§4.5)。

### 4.2 moniker(Symbol 文法)設計

```
<scheme> ' ' <manager> ' ' <package-name> ' ' <version> ' ' <descriptors>
librarian-go . . . `store/memstore.go`/MemStore#Complete().
```

- **scheme**: `librarian-ts` / `librarian-go` / `librarian-php`(`ToolInfo.name` と一致)。
- **package**: `. . .`(すべて空 placeholder)。repo を入れない(原則 3)。言語の package
  概念(Go module path 等)を入れるのは相互運用が要件化した時の拡張余地として空けておく。
- **descriptors**: 先頭に **repo 相対ファイルパスを namespace descriptor** として置く
  (scip-typescript と同じ流儀。`/` は identifier 文字でないためバッククォートでエスケープ)。
  以降は container 連鎖 → 自身、の順。suffix は kind から機械的に決まる:
  type 系(class/struct/interface/trait/enum)= `#`、function/method = `().`、
  variable/typealias = `.`、module = ファイル descriptor のみ。
- **testblock は local symbol**(`local N`)。Document 外からアクセスできない実行ブロックで
  あり SCIP の local の定義に合致する。`N` は Document 内の emit 順(span 順)の連番で決定的。
  `enclosing_symbol` に親(module / 関数 / 親 testblock)の moniker を張り、`display_name` に
  ブロック名、definition occurrence に `SymbolRole.Test` を立てる。→ ネスト連鎖がベース層
  だけでも outline として読める。
- **moniker ⇄ 既存 id の対応**: descriptors から file / container 連鎖 / name / kind が
  一意に復元できるため、`h20(file::container::name::kind)` を moniker から決定的に再計算
  できる。この写像関数を `src/protocol/scip.ts` に 1 つだけ定義し、emit 側と ingest 側で共有する
  (非衝突性は既存 id スキームと同等)。

### 4.3 ベース層への写像(現行行 → SCIP)

| librarian | ベース SCIP | 忠実度 |
|---|---|---|
| SymbolRow(module〜variable) | `SymbolInformation`(kind / documentation / signature_documentation / display_name)+ definition `Occurrence`(range = 名前位置、`enclosing_range` = span 全域) | 忠実(SCIP の方がリッチ) |
| kind | module→`File`、function→`Function`、method→`Method`、class→`Class`、struct→`Struct`、interface→`Interface`、trait→`Trait`、typealias→`TypeAlias`、enum→`Enum`、variable→`Variable` | 忠実 |
| testblock | local symbol + `enclosing_symbol` 連鎖 + `SymbolRole.Test`(kind は Unspecified) | 部分的(kind と第一級性は ext が正) |
| edges: imports | `SymbolRole.Import` 付き occurrence | 忠実 |
| edges: extends | `Relationship { is_implementation: true }` | 忠実 |
| edges: calls / references | reference occurrence(参照位置に emit) | **種別区別が写らない(ext が正)** |
| edges: resolved=false | **出さない** | ext のみ |
| span(1-based 行) | `enclosing_range`(0-based・half-open)へ変換 | 忠実 |

### 4.4 拡張層(ext)スキーマ

規約: **ext はベースへの delta であり、ベースの再記述をしない。** ベースから写像できる情報
(通常シンボルの kind・doc・span 等)は ext に置かない。将来フィールドは追加のみ
(後方互換)、未知フィールドは無視。

```jsonc
{
  "version": 1,
  "documents": [                       // 現行 ExtractionResult と同じ file 単位
    {
      "relativePath": "store/memstore_test.go",
      "symbols": [                     // ベースで表現しきれないシンボルの上乗せ(現状 testblock のみ)
        { "symbol": "local 0", "kind": "testblock", "name": "TestMemStoreComplete",
          "container": null, "spanStart": 10, "spanEnd": 42 }
      ],
      "edges": [                       // エッジの正(全種別・全エッジ)
        { "from": "<moniker>", "to": "<moniker>", "toName": "Complete",
          "kind": "calls", "resolved": true },
        { "from": "<moniker>", "to": null, "toName": "helperFn",
          "kind": "references", "resolved": false }
      ]
    }
  ]
}
```

- `edges[].from/to` は moniker(testblock は同一 Document 内の local id)。ingest が
  §4.2 の写像関数で既存 id 形式へ変換する。
- file 単位の構造は store の `replaceFile`(インクリメンタル更新)との対応を保つため。

### 4.5 ingest(SCIP+ → store)の二経路

写像コードは一本化し、エッジ源だけが分岐する:

- **シンボル**: 常にベース SCIP から写像(native / 外部で共通)。testblock 等は ext.symbols
  で上書き・追加。
- **エッジ**: `ext` があれば **ext.edges が正**(native 経路)。無ければ(外部 `.scip`)
  ベース occurrence から **degrade 導出**:
  - 初版の degrade 規則: Import role → imports、`is_implementation` → extends、その他の
    reference occurrence → **一律 references**。resolved は常に true(unresolved は存在
    しない)。testblock は `SymbolRole.Test` + enclosing_range から部分再構成(ネストは
    enclosing_symbol があれば使う)。
  - 「definition の enclosing_range に空間包含される参照 → 擬似 calls」への昇格は、外部
    インデクサの enclosing_range 充足率に依存するため初版に入れない。**degrade 用の重み
    戦略(種別区別なし)は `librarian learn` の掃引対象にする**(§4-⑤ と接続 — 外部 .scip
    リポジトリでの最適戦略はハンドチューンでなく学習で決める)。
- **dispatch 優先度**: 同一言語で native extractor と外部 `.scip` が両方ある場合、
  **native が常に勝つ**(ext を持つ方が retrieval 信号が多い)。外部 `.scip` は
  「native extractor が無い言語の取り込み口」。
  → **実装(Step 5)**: degrade 取り込みは、登録 extractor が claim する拡張子の
  ドキュメントをスキップする(report の `skippedNativeFiles`)。ext サイドカー付き
  import は native 信号そのものなのでスキップ対象外(`export --scip` 往復が成立)。
  あわせて `index` / `import` はファイル**削除の管轄を「自分が扱う拡張子」に限定**する
  (index = 登録 extractor の拡張子、import = 今回 ingest した拡張子)— これが無いと
  同一 repo で native 行と import 行が互いを全削除してしまい、共存
  (例: TS native + Python scip)が成立しない。

## 5. 段階計画(B-first)

| Step | 内容 | 完了条件 |
|---|---|---|
| 0 | 本文書 + ADR-6 の合意、issue #16 へ反映 | レビュー済み・dlog 記録 |
| 1 | `src/scip.ts`: 型(封筒 / ext)、`.scip` encode/decode、moniker ⇄ id 写像、範囲変換 | ユニットテスト(moniker 往復・id 一致・エスケープ) |
| 2 | **go-extractor を SCIP+ emit に載せ替え**(protojson + 参照位置取得)、indexer の ingest を SCIP+ 経由に | `eval golden/go-taskflow.json` の結果セットが載せ替え前と**完全一致**(micro 95.7% / 45/47) |
| 3 | php-extractor(手組み JSON)、TS(in-process、プロセス境界なしで同じ封筒型を渡す)を横展開 | PHP: 88.1% / 37/42、TS: 87.0% と完全一致 ※ |

※ Step 3 実施時の注記: weather-you-travel は committed fixture が無くローカルで再計測
できないため、TS のゲートは **self-index(codex-librarian 自身、symbols 343 + edges 1690)の
store 行ダンプ完全一致**で代替した(fixture より大きい実コーパスでの同一性)。PHP・Go は
store 行 + eval 出力の両方でバイト単位一致を確認済み。
| 4 | `librarian export --scip` + 外部 `.scip` import + **scip-python PoC**(degrade 経路) | `graph`/`pack` が動く + golden 作成 + `docs/scip-baseline.md` に実測 |
| 5 | dispatch 優先度の実装 + README(SCIP+ 経路の使い方) | selfindex 再生成・ドキュメント ※2 |

※2 Step 5 実施時の注記: dispatch は §4.5 の実装注記のとおり(degrade スキップ +
削除管轄の限定)。回帰は Go 95.7%(45/47)・PHP 88.1%(37/42)・Python degrade
88.1%(37/42)すべてベースラインと完全一致を確認。

- Step 2 の回帰は go-baseline.md の失敗分析 2 件(gtf-001 の interface 越し呼び出し等)が
  **同じ理由で miss のまま**であることも確認する(別の理由で同数になっただけ、を検出する)。
- Step 4 は未実装言語の追加であり回帰ゲートの対象外(issue の注意書きどおり)。degrade の
  数値は改善対象ではなく**ベースライン記録**(native との差 = ext の価値の実測になる)。

## 6. リスクと実装時の検証事項

1. **参照位置の追加取得**(3 言語)が emit 書き換えコストの実体。位置は store 写像では
   捨てる(store スキーマ不変)が、ext ではなくベース occurrence が保持するため将来の
   retrieval 信号(参照密度等)として残る。
2. **local symbol の決定性**: `local N` の採番は span 順で規約化。ドキュメント間で
   独立なので並列抽出でも安定。
3. **proto3 canonical JSON の相互一致**: Go `protojson` と `@bufbuild/protobuf` の JSON
   表現(enum の名前文字列、64bit int の文字列化)の一致を Step 2 でゴールデンファイル
   テストにする。
4. **scip-python の充足率**: enclosing_range / enclosing_symbol / Test role をどこまで
   埋めるかは実測(Step 4)。欠けても §4.5 の degrade 規則は成立する。
   → **実測済み(Step 4、scip-python 0.6.6)**: kind は全件 Unspecified、Import role・
   Test role・typed_range は不使用、enclosing_range は定義 occurrence に付く。degrade
   規則は成立したが、kind の moniker 文法からの導出・module 形 moniker(`__init__:`)の
   合成 module 行へのエイリアス・module 形参照→imports のヒューリスティックを ingest に
   追加した。実測値と失敗分析は `docs/scip-baseline.md`(88.1% — PHP native と同値)。
5. **selfindex / dlog への影響**: id スキーム不変のため self.db・dlog anchor の id 連続性は
   保たれる。Step 3(TS 載せ替え)後に `npm run selfindex` の完全一致で確認。

## 7. ADR 変更提案(architecture.md §5 への追記文面)

> **ADR-6: 抽出器と store の間の交換フォーマットは SCIP ベース層 + 拡張層の二層(SCIP+)**
> 理由: (1) 標準フォーマットの取り込み口により、native 抽出器を書かずに外部 `scip-*`
> インデクサの言語を追加できる。(2) index を `.scip` として export でき、SCIP エコシステムと
> 相互運用できる。(3) retrieval を駆動する固有信号(エッジ種別・unresolved・testblock)は
> SCIP に表現が存在しないことを仕様確認で確定済みのため、サイドカー拡張(ext)を正とし、
> ベース SCIP は標準準拠の投影とする。ADR-1 とは非衝突(SCIP+ は抽出→store 間の契約で、
> 保存先は SQLite のまま)。ADR-2 とも非衝突(抽出は言語ごと native のまま。#7/#8 で却下
> したのは「外部 SCIP インデクサへの置き換え」であり、本 ADR は交換フォーマットの標準化)。
> トレードオフ: 参照位置の追加取得と二層の維持コスト。native 経路の精度は ext が担うため
> SCIP 化そのものによる精度向上は無い(相互運用と言語追加コスト削減への投資)。外部 `.scip`
> はエッジ種別・unresolved・testblock ネストが欠落した degrade 動作となり、その実測値を
> `docs/scip-baseline.md` に記録する。

## 8. issue #16 スコープとの対応

- 「SCIP スキーマ取り込み」→ Step 1(`@scip-code/scip` を採用。issue 記載の
  `@sourcegraph/scip` は旧名)。
- 「SCIP+ 拡張スキーマの定義」→ §4.4(本文書がその文書化)。
- 「native 抽出器 → SCIP+ emit(まず 1 言語)」→ Step 2 で **Go を選定**(公式 bindings が
  あり、`docs/go-baseline.md` に回帰比較の土台がある)。
- 「store/retrieval を SCIP+ 消費に切替」→ Step 2-3(retrieval は無変更で済む —
  store 写像の入口が変わるだけで symbols/edges テーブルは不変)。
- 「外部 `.scip` 取り込み」→ Step 4(scip-python)。
- 「native と外部の棲み分け」→ §4.5 dispatch(native 優先)+ Step 5。
