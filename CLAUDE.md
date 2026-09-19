# CLAUDE.md — e-nexus-decision-layer

このrepoは E-NEXUS 共通 Decision Layer（MA-30）。正本は EN-Knowledge-Vault
`AI-Workflow-System/07_project-kits/AI開発環境改善マスタープラン_E-NEXUS-Decision-Layer構想_2026-09-19.md`。
矛盾時は 1. 現行コード・テスト → 2. Vault正本 → 3. 実行タスク台帳・開発ログ → 4. README の順。

## 絶対に破らないこと

- **Decision Layer は承認しない。** `policies/safety/human-only.json` の `forbidden_outcome_keys` と
  `human_only_decision_types` を削らない・緩めない。tests/human-gate.test.mjs を通らない変更はしない。
- **Jev を中心に固定しない。** 本体（`src/core/`）に Jev 固有の型・API 形式を持ち込まない。Jev の変更は `src/adapters/jev/` 内で完結させる。
- **各アプリから Jev を直接呼ばせない。** 呼び出しは CLI / SDK 経由。販売アプリは App → E-NEXUS Backend → Decision Layer。
- **APIキーを保存しない。** `.env.example` にはキー「名」だけ。値・ログ出力・commit は禁止。
- **ネットワークは既定で無効。** `EDL_ALLOW_NETWORK=true` を勝手に設定しない。
- **en-generate-hub / en-product-hub / 各アプリrepo を編集しない。** 接続は将来 integration 側で外から行う。
- **Git**：Vault の CLAUDE.md「Git運用」「Human-only操作」に従う。force push / reset / rebase / stash / branch削除は禁止。
  remote 作成（`gh repo create`）と push 先の設定は Human-only。

## 作業の型

1. `npm test` が通る状態から始める（依存ゼロ・`node --test`）
2. 変更は Adapter / Policy / Schema / Registry のいずれかに閉じる。Engine を触るときは Advisor 相談（ハーネス変更相当）
3. 閾値（`policies/routing/confidence-thresholds.json`）は usage.jsonl の実測を根拠に変える
4. 作業ログは Vault `02_Development-Logs/YYYY-MM/` へ（common-dev-log）
