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
   rules   jev(stub)   mock-jev   local(stub)   llm(stub)   human
```

## 2. 判断の流れ

1. **deterministic rules**（`policies/routing/rules/<decision_type>.json`）で解ければ confidence 1.0 で確定
2. 解けなければ **probabilistic Adapter**（jev → mock-jev → local → llm）。Jev は低コストGateとして既定で試す。高コストな汎用LLM（`policies/cost/limits.json` の `paid_providers`）は `options.allow_paid_adapters=true` のときだけ
3. **confidence → tier**：`auto`（≥ auto_min）/ `review`（≥ review_min）/ `human`。閾値は policy、コード固定しない
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
