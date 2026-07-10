# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Codex Librarian** — コードベースの「理解負債」を返済する AI レビュー & 知識資産化プラットフォーム。
`docs/architecture.md` が **WHY/WHAT の source of truth**。原則・ADR(§5)に反する設計はしない。
反する必要が生じた場合は実装せず ADR 変更提案として返すこと(§9)。

- **Graph-first**: レビュー/検索の単位は diff ではなく「diff が触れたコードグラフ上の近傍」。
- **単一 SQLite・ローカル完結**(ADR-1)。運用ミドルウェアを持たない。
- **抽出器は TypeScript Compiler API**(ADR-2)。tree-sitter ではない。`allowJs` で JS/JSX も対象。
- **全機能はまず CLI**(`librarian`)として存在する。

## Commands

```bash
npm install          # 依存インストール
npm run build        # tsc で dist/ へビルド
npm test             # node --test によるユニットテスト
node dist/cli.js --help          # ビルド後の CLI
librarian index <repo>           # リポジトリをインデックス
librarian stats                  # ストア統計
librarian graph <symbol>         # k-hop 近傍探索
librarian eval <golden.json>     # retrieval match 率の計測(ADR-4)
librarian pack <diff>            # 区画付き Context Pack(markdown)
librarian review <diff> --markdown   # Claude API でレビュー生成(要 ANTHROPIC_API_KEY)
librarian learn <golden.json> --holdout  # 戦略掃引 → PatternCache 昇格(§4-⑤)
librarian history                # 精度の時系列(ADR-4)
librarian feedback <id> --good   # 人間の 👍/👎 を retrieval_log へ
```

## Decision logging with dlog (required)

このリポジトリでは **すべての実装判断を [dlog](https://github.com/nonokia/dlog) に記録する**。
使い方の詳細は `AGENTS.md` を参照。運用ルール:

1. セッション開始時に identity を export し、`dlog status` で staging の残骸を確認する。
2. 設計判断をした瞬間に `dlog record --rationale ... --file <anchor>` する
   (却下した代替案は `--rejected "approach :: reason"`、制約は `--declares-invariant`)。
3. コミットは `dlog commit -m "..."` を使う(git commit 後に staged decisions を自動 seal)。
4. **`.dlog/dlog.db` はリポジトリにコミットする**(このプロジェクトの実験目的:
   意思決定ログをコードと一緒に持ち運ぶ)。seal はコミット後に db を書き換えるため、
   db ファイル自体は次のコミットで取り込まれる(1 コミット遅れで追従)。
5. コードを変更する前に `dlog why <file>` / `dlog context <path>` で過去の決定を確認する。

## Layout

- `docs/architecture.md` — アーキテクチャ設計書(WHY/WHAT)。フェーズ計画・ADR・成功指標。
- `docs/phase0-report.md` — Phase 0 ベースライン計測と失敗分析。**retrieval を変更したら
  必ず `librarian eval` を回して数値を更新すること(ADR-4)。**
- `src/store.ts` — Knowledge Store(`node:sqlite`)。files/symbols/edges + 再帰 CTE。
- `src/indexer.ts` — Indexer。TS Compiler API で symbols/edges を抽出。
- `src/extractor.ts` — Extractor インターフェース(多言語対応の抽象、v1 実装は TS のみ)。
- `src/diff.ts` / `src/retrieval.ts` — unified diff → シード → 決定的展開(ADR-3 stage 1)。
- `src/eval.ts` + `eval/golden/` — Phase 0 評価ハーネスと正解セット(規律は `eval/README.md`)。
- `src/loop.ts` — 自己改善ループ(§4-⑤): 戦略候補・learn 掃引・レビュー結果の還流。
  数値は `docs/phase4-report.md`(train=test と holdout の区別に注意)。
- `src/contextpack.ts` — Context Pack 組み立て(§4-③ の区画: 変更/呼び出し元/呼び出し先/テスト)。
- `src/review.ts` — Claude API でのレビュー生成(構造化出力)。モデル既定は `claude-opus-4-8`。
- `templates/librarian-review.yml` — 対象リポジトリに配る GitHub Actions テンプレート(§4-④)。
- `src/cli.ts` — CLI エントリポイント。
- `.dlog/dlog.db` — dlog の意思決定ログ(コミット対象)。
