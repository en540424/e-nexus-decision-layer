# e-nexus-decision-layer

E-NEXUS 全体で共通利用する **Decision Layer**。AI非依存・IDE非依存の「判断基盤」。

```
App / Agent / IDE（Claude Code・Cursor・Hermes・各アプリ）
  ↓  CLI（src/cli.mjs）または SDK（src/index.mjs）
E-NEXUS Decision Layer（core: engine / router / fallback / confidence）
  ↓  Adapter Interface（src/adapters/adapter-interface.mjs）
Rules ／ Jev（direct・vercel実装、cloudflare予約）／ Mock Jev ／ Local（stub）／ LLM（stub）／ Human
```

- **Jev（TypeSafe AI）は Adapter の1つ**。本体は Jev を知らない。差し替え・併用できる。
- **deterministic rules を先に評価**し、解けないときだけ確率的 Adapter → 最後は必ず Human。
- **承認はしない**。outcome に `approved` 等の承認キーは構造上存在できず（`policies/safety/human-only.json`）、
  既存の Human-only ゲート（en-generate-hub 承認チェーン・Claude Code permissions・Product Hub 更新ボタン）は一切変更しない。
- **APIキー不要で動く**。`JEV_API_KEY`（direct）／`AI_GATEWAY_API_KEY`（vercel、`JEV_PROVIDER=vercel`のときのみ。加えて`npm install`でoptionalDependencyの`ai`が要る）が無ければ Jev Adapter は unavailable 扱いになり Mock / Human へ落ちる。キーと `EDL_ALLOW_NETWORK=true` が揃えば Jev は**既定で呼ばれる**（低コストGateが役割なので Cost Gate の対象外）。Claude／GPT 等の LLM Adapter は `options.allow_paid_adapters=true` のときだけ。
- **usage metering** は初日から（`data/usage/usage.jsonl`、USD micros）。1行 = 1判定で、top-level は final resolver の usage、`attempts[]` / `usage_total` は途中で実際に呼んだ provider（低confidenceで human へ落ちた実 Jev 等）の usage も含む（docs/architecture.md §11）。

## 使い方

```bash
npm test                                     # 185 tests, 依存ゼロ（node --test）
node scripts/poc-calibration.mjs dry-run     # Confidence Calibration（Rules First 件数と送信予定 questions。ネットワーク無し）
node src/cli.mjs types                       # decision_type 一覧
node src/cli.mjs decide --json '{"decision_type":"paid-generation-gate","application_id":"claude-code","project_id":"openmontage","input":{"asset_kind":"subtitle","purpose":"jp caption"}}'
node src/cli.mjs decide --file docs/growth/content-publish-gate.sample-request.json   # MA-31 G3 公開前判定（公開はしない）
node src/cli.mjs decide --file docs/growth/channel-selection.sample-request.json      # MA-31 G3後半 候補媒体選定（投稿はしない）
node src/cli.mjs registry skills --project travel-rate-camera
node src/cli.mjs registry-check
node src/cli.mjs usage --by tenant
node src/cli.mjs usage --attempts --by provider   # attempt 単位（final が human でも途中の real provider を数える）
```

終了コード: `0` 成功 / `2` schema・入力エラー / `3` Human Gate 違反 / `1` その他。

## ディレクトリ

| パス | 役割 |
|---|---|
| `src/core/` | decision-engine / router / fallback / confidence / errors |
| `src/adapters/` | adapter-interface と jev（+ jev-provider-interface：direct / vercel / cloudflare 経路）/ rules / llm / local / human |
| `src/registries/` | Project / Skill / Agent / Model Registry の解決（`registries/*.json` を読む） |
| `src/schemas/` | 依存ゼロの JSON Schema サブセット検証器 + loader |
| `src/usage/` | metering（JSONL 追記・集計） |
| `registries/` | 4台帳（Vault側正本の派生スナップショット） |
| `policies/` | routing（chain・閾値・rules）/ safety（Human-only）/ human-approval / cost |
| `schemas/` | common + ドメイン別 decision_type schema（openmontage / growth / ai-phone / travel-rate-camera / ai-cost-manager / claude-code）。growth の `content-publish-gate`（公開前判定）・`channel-selection`（候補媒体選定）はどちらも実行はしない（`docs/growth-content-publish-gate.md`・`docs/growth-channel-selection.md`） |
| `integrations/` | claude-code / cursor / hermes からの呼び出し方（本体は変更不要） |
| `tests/` | schema / registry / routing / fallback / adapter failure / human gate / metering / PoC |
| `scripts/` | poc-calibration（Jev confidence の実測 runner。run はキー export 済みの Human シェルでのみ動く） |
| `docs/` | architecture / PoC / decision-log / poc/calibration（ケース定義・結果） / growth-content-publish-gate（MA-31 G3）・growth-channel-selection（MA-31 G3後半）＋ growth/（Human smoke 用サンプル） / roadmap-future-use-cases（Browser・Computer Use micro decision／Context Relevance Filter／I/O Guard補助／Post-Execution Verification） |

## 正本

- 構想・設計の正本：EN-Knowledge-Vault `AI-Workflow-System/07_project-kits/AI開発環境改善マスタープラン_E-NEXUS-Decision-Layer構想_2026-09-19.md`（MA-30）
- 矛盾時の優先順位：1. 現行コード・テスト → 2. Vault 正本 → 3. 実行タスク台帳・開発ログ → 4. このREADME

## やらないこと

全Projectへの一括導入／既存 Harness の書き換え／Human-only 承認の置換／Jev 依存アーキテクチャ／APIキーのrepo保存。
