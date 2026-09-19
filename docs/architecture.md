# Architecture

## 1. 位置づけ

```
┌──────────────────────────────────────────────────────────────┐
│  Callers（Jev を知らない）                                     │
│  Claude Code ─┐   Cursor ─┐   Hermes ─┐   販売App → E-NEXUS Backend │
└───────────────┼───────────┼───────────┼────────────────────────┘
                ▼           ▼           ▼
        integrations/*  （薄い呼び出し規約。CLI or SDK）
                ▼
┌──────────────────────────────────────────────────────────────┐
│  E-NEXUS Decision Layer                                        │
│   1 schema validation  → 2 safety(Human-only) → 3 registry候補   │
│   4 router(chain)       → 5 fallback + confidence → 6 human gate │
│   7 outcome validation  → 8 usage metering                      │
└──────────────────────────────────────────────────────────────┘
                ▼   Adapter Interface（supports / decide）
   rules   jev(direct実装済み・vercel実疎通済み)   [mock-jev]   local(stub)   llm(stub)   human
```

## 2. 判断の流れ

1. **deterministic rules**（`policies/routing/rules/<decision_type>.json`）で解ければ confidence 1.0 で確定
2. 解けなければ **probabilistic Adapter**（jev → [mock-jev] → local → llm）。Jev は低コストGateとして既定で試す。高コストな汎用LLM（`policies/cost/limits.json` の `paid_providers`）は `options.allow_paid_adapters=true` のときだけ。
   **mock-jev は「実 Jev 経路が使えない（キー無し／Network Gate OFF）とき」だけ既定 chain に入る**（`src/index.mjs` `defaultAdapters` が `realJevUsable(env)` で判定）。実 Jev が正常応答した結果を mock のヒューリスティックが上書きすることはない（2026-09-19 実疎通で観測した欠陥の修正。詳細は decision-log）
3. **confidence → tier**：`auto`（≥ auto_min）/ `review`（≥ review_min）/ `human`。閾値は policy、コード固定しない。
   Adapter が**正常応答したが human 相当**の場合は trace に `status:'ok'` として残し（unavailable とは区別）、chain の次（local → llm の再判定差し込み口 → human escalation）へ進む。正常応答は provider 失敗ではない。
   既知の残課題：chain が継続した場合、実 Jev の confidence / usage は `fallback.trace` にだけ残り、`result` と metering には出ない（2026-09-19 記録。修正は未着手）
4. **Human gate**：`policies/safety/human-only.json` の `force_human_when_outcome_keys`（`human_review_required` / `needs_human_review` / `human_required`）のいずれかが true なら confidence に関わらず `human`。Human-only な decision_type は Adapter を呼ばない
5. chain を使い切れば **Human Adapter** が escalation を返す（承認ではない）

## 3. なぜ Jev を中心にしないか

- Jev は「classify / route / score / typed decision」に強く「長文生成・深い原因分析・設計」には向かない
- 判定モデルは今後も入れ替わる（Rules / Local / Claude / GPT）。本体が Adapter Interface だけを知れば差し替えは Adapter 1ファイルで済む
- Jev の confidence を「安全機構」にしない。安全機構は既存ゲート（en-generate-hub・Claude Code permissions・Hub更新ボタン）

## 4. Registry

Jev にファイルシステムを探索させない。`registries/{projects,skills,agents,models}.json` から
`resolveCandidates(kind, { projectId, tags })` が **global + そのプロジェクト** の候補だけを返し、Adapter へ渡す。
Vault 側の人間向け台帳（Skill台帳・managed-repos.json・Advisor正本）が上位正本。

## 5. Usage / Cost

1判定 = 1行 JSONL。`application_id / project_id / tenant / provider / model / decision_type / tokens / estimated_cost_usd_micros / fallback_occurred / human_escalation`。
販売版では tenant 別に集計し料金設計・原価管理へ使う。有料生成そのものの費用は en-generate-hub 課金台帳が正本（二重管理しない）。

## 6. 販売Application

```
App（キー無し） → E-NEXUS Backend（Decision Layer をサーバ側で実行） → Adapter → Jev
```
Client App に Jev API Key を持たせない。metering の tenant はここで付与する。

## 7. 拡張手順

| 追加したいもの | 触る場所 | 触らない場所 |
|---|---|---|
| 新しい decision_type | `schemas/<domain>/*.schema.json` + `schemas/common/decision-types.json`（+ rules） | core |
| 新しい判定エンジン | `src/adapters/<name>/` + `policies/routing/default.json` | core・他Adapter |
| 新しい呼び出し元 | `integrations/<name>/` | core |
| 閾値変更 | `policies/routing/confidence-thresholds.json` | core |

## 8. 責務の3段構造（Pre-Decision / Execution / Post-Execution Verification）

```
Pre-Decision                 Execution                    Post-Execution Verification
（Decision Layer）           （既存Harness / App / Skill）  （Decision Layer・将来）
 typed decision を返す   →   呼び出し側が実行する     →   結果を typed verdict で仕分ける
 tier: auto/review/human     既存ゲートを必ず通る          PASS / RETRY / REVIEW / ESCALATE / HUMAN
```

- **Pre-Decision** が現在の実装範囲（engine 8段のすべて）。outcome は schema で閉じ、承認キーは存在できない
- **Execution** は Decision Layer の外。en-generate-hub の承認チェーン・Claude Code permissions・Hub 更新ボタンはここで効く
- **Post-Execution Verification** は `post-execution-verify`（予約・未実装）。verdict は「次に誰が見るか」を表すだけで、
  HUMAN / ESCALATE を Jev の confidence で PASS に変えることはできない（`force_human_when_outcome_keys` と同じ扱いにする）

## 9. Jev 到達経路（Provider）を固定しない

```
Decision Layer → Jev Adapter（変換だけ） → Jev Provider（経路だけ）
                                          ├─ direct     TypeSafe Direct API（実装済み。2026-09-19公式API仕様確認）
                                          ├─ vercel     Vercel AI Gateway（実装済み。2026-09-19公式仕様確認）
                                          └─ cloudflare Cloudflare 経由（予約）
```
`JEV_PROVIDER` で切替（既定 `direct`）。経路の追加は `src/adapters/jev/jev-provider-interface.mjs` の契約を満たす1ファイルで済み、Adapter・Engine は変更しない。
API 仕様が未確認の経路（cloudflare）は `available()` が `JEV_ROUTE_NOT_IMPLEMENTED` を返し、Engine は次の Adapter へ落ちる。

`direct`（`src/adapters/jev/jev-direct-provider.mjs`）は `POST https://api.typesafe.ai/v1/systemone` へ
Bearer認証で送る実装（Node組み込み `fetch`のみ、依存追加なし）。403/422/429/529/5xx/timeoutの分類とリトライ
（408・429・5xx・timeoutのみ、`Retry-After`尊重、最大2回）、Network Gate二重チェック、Secret非表示はここで完結する。
outcome schema → Jev questions（noul/choice/score）の写像と confidence 合成は `src/adapters/jev/jev-adapter.mjs`
（変換層）が持つ。**APIキー未取得のため実疎通は未実施**（unit tests はすべて fake fetch。実APIは明示した
integration test のみで叩く）。詳細仕様は 2026-09-19 MA-30開発ログ「Jev公式API仕様の確定」節を正本とする。

`vercel`（`src/adapters/jev/jev-vercel-provider.mjs`）は Vercel AI Gateway の Evaluation modality
（AI SDK 7 の `experimental_evaluate`。**REST互換エンドポイントには無い**、と公式に明記されている）を経由する。
Gateway 側の質問型（`boolean`/`choice`/`score`、choice/score の confidence は `providerMetadata.typesafe.confidence`
側）と Direct の内部形（`noul`/`choice`/`score`、confidence は answer 側）が異なるため、この Provider は
「経路＋相互変換」を持つ（`jev-adapter.mjs` は変更しない）。依存パッケージ `ai`（AI SDK v7、**Node.js 22+ 必須**）は
Decision Layer 全体の依存ゼロ方針とは別枠で `package.json` の `optionalDependencies` に置き、動的 `import('ai')` で
読み込む。未インストールなら `JEV_VERCEL_SDK_MISSING` で unavailable になり、direct/mock/rules 経路や既存テストには
一切影響しない。**2026-09-19 実疎通成功**（`JEV_PROVIDER=vercel`・model `typesafe-ai/jev`・約3.1s・confidence≈0.08。
`createGateway({apiKey}).evaluationModel()` の実在もこれで確定）。正規モデルIDは `typesafe-ai/jev`（`DEFAULT_VERCEL_MODEL_ID`。
`JEV_VERCEL_MODEL` で上書き可。Direct 用の `JEV_MODEL`／内部既定 `jev-latest` は Gateway 側へ持ち込まない）。
403 は 401（キー不正）と分けて `JEV_FORBIDDEN`（カード未認証・モデル権限・Gatewayポリシー等）。
unit tests はすべて注入した `evaluateImpl` で、実 SDK・実ネットワークを一切使わない。詳細は 2026-09-19 MA-30開発ログ
「Vercel AI Gateway経由 Jev 実接続」「実疎通成功後の正式反映」節を正本とする。

## 10. 仕様に固定しない情報

レイテンシ（ms）・上位モデル比の速度／価格・選択肢数上限・学習手法の詳細・ベンチマーク順位などの**ベンダー公表値は Decision Layer の仕様にしない**。
閾値・chain・Cost Gate はすべて policy と usage.jsonl の実測で決める。参考値を残す場合は出典付きで `docs/` に置くだけにする（本 repo には現時点で出典確認済みの値が無いため記録していない）。
