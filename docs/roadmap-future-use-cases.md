# Roadmap: 将来ユースケース（2026-09-19 追記・いずれも未実装 → 2026-09-29 現在の状態は下表の「実装状態」列）

MA-30 土台構築後に追加確認した Jev の有力用途を、Decision Layer の正式な将来ユースケースとして記録する。
本 docs は「名前と責務境界の予約」であり、schema・rules・Adapter・接続は作っていない（2026-09-29 更新：`automation-safety-gate`・`customer-reply-gate`・`lead-triage` は実働化した＝下の表。`next-best-action` 等の残りは予約のまま）。
共通原則：**Jev は判定補助であり、Safety 解除・承認・Human-only 置換はどの用途でも行わない。**

| # | 用途 | 予約した decision_type | 呼び出し元 | 実装状態 |
|---|---|---|---|---|
| 1 | Browser / Computer Use 向け micro decision | `agent-action-micro` | Hermes・ブラウザ自動化・Computer Use・将来Agent | 予約のみ |
| 2 | Context Relevance Filter | `context-relevance` | Claude Code・Cursor・Hermes（上位LLM投入前） | 予約のみ |
| 3 | Input / Output Guard 補助 | `io-guard-assist` | 全呼び出し元 | 予約のみ（禁止キー先置き）。2026-09-29：PII らしい文面を Jev へ送ることになり en-sns-hub・crm-core の PII 境界と矛盾するため、作らない（設計判断） |
| 4 | Post-Execution Verification | `post-execution-verify` | 全呼び出し元 | 予約のみ。2026-09-29：呼ぶ consumer が無い（crm-core は結果不明を自動で直さない設計）ため予約のまま |
| 5 | Growth：公開候補ゲート | `content-publish-gate` | Claude Code 本体（note-check 後）・将来 Hermes | **実装済み（2026-09-23 MA-31 G3）**。`docs/growth-content-publish-gate.md` |
| 6 | Growth：チャネル選定 | `channel-selection` | Claude Code 本体・将来 Hermes | **実装済み（2026-09-23 MA-31 G3後半）**。`docs/growth-channel-selection.md` |
| 7 | Growth：Lead トリアージ | `lead-triage` | 電話AI・公式サイト Contact・ココナラ問い合わせ | **実装済み（2026-09-29・FB-04）**。入力写像は crm-core `src/decision/decision-inputs.mjs` |
| 8 | Growth：次アクション | `next-best-action` | AI Company V1 §8 Growth 手順 | 予約のみ（2026-09-23）。2026-09-29：呼ぶ consumer と入力の実データが無いため予約のまま（schema だけ作っても使われない） |
| 9 | Growth：返信ゲート | `customer-reply-gate` | AI Company V1 §9 Customer 手順・crm-core G5 executor の preflight | **実装済み（2026-09-29・FB-04）** |
| 10 | Growth：自動化安全ゲート | `automation-safety-gate` | crm-core G5 executor の preflight・将来の n8n / Hermes 連携 | **実装済み（2026-09-29・FB-04）** |

予約は `schemas/common/decision-types.json` の `reserved_decision_types`。schema が無いため `decide()` は `UNKNOWN_DECISION_TYPE` を返す（誤って動かない）。

## 1. Browser / Computer Use 向け micro decision

- 対象：click / type / back / continue / retry / stop / tool選択 / sub-agent選択 のような、連続して大量に発生する小さな判断
- 位置づけ：上位LLMに毎回聞くほどではない判断を、Registry が絞った候補（tool / sub-agent）の中から型付きで選ぶ
- 境界：`stop`・「人に聞く」は tier=human へ写像。送信・購入・ログイン・本番操作は Human-only のまま（Safety台帳§4・§5-1）
- Claude Code 専用にしない。Hermes・ブラウザ自動化・Computer Use・将来Agent が同じ CLI / SDK を使う（`integrations/hermes/README.md`）

## 2. Context Relevance Filter

- 対象：ログ・tool result・Skill情報・過去 context を上位LLMへ渡す**前**に「今のタスクに必要か／残すか／削除可か／優先度」を高速判定し、投入量を減らす
- 思想：**要約AIではない**。Decision Layer → relevance decision → 必要な情報だけ LLM へ、という仕分け
- 既存との関係：Vault の `context-diet` Skill（S/M/L・読む範囲を先に決める運用規範）とは**補完関係**。context-diet は「人とAIが何を読むか決める規範」、本用途は「渡す直前の機械的な仕分け」。置換しない
- 境界：削除判定は「LLM へ渡さない」だけで、Vault・ログの実体を消す権限は持たない

## 3. Input / Output Guard 補助

- 対象：PII 含有可能性／機密情報含有可能性／suspicious input／suspicious output／LLM 出力品質／security alert triage／escalation 推奨
- 構造：**Jev → 「怪しい可能性あり」→ 既存 Safety / Human へ Escalate**。検知と推奨だけ
- 禁止：Jev 判定だけで Safety 解除・承認・ブロック解除を行わない。`policies/safety/human-only.json` の `forbidden_outcome_keys` に `safety_cleared / guard_released / unblock / release_block / allow_execution` を先に置き、outcome に現れたら `HumanGateViolationError` で停止する
- 既存との関係：Hook（guard-*.js）・deny・autoMode hard_deny・en-generate-hub の承認チェーンが最終安全機構。本用途はその**手前の補助**

## 4. Pre-Decision / Execution / Post-Execution Verification

- Decision Layer の責務は **Pre-Decision**（現在の実装範囲）と **Post-Execution Verification**（将来）。**Execution は外**（既存 Harness / App / Skill が既存ゲートを通して実行）
- Post-Execution の verdict：`PASS / RETRY / REVIEW / ESCALATE / HUMAN`。「次に誰が見るか」を表すだけで、HUMAN / ESCALATE を confidence で PASS に変えることはできない（`force_human_when_outcome_keys` と同じ扱いにする）
- 既存との対応：Product Hub pull-plan（auto / claude / human）、en-sns-hub（confirmed / needs_review）、Codex / independent-inspector の検品と語彙を写像できるようにする（既存側の語彙は変えない）
- 図と責務説明は `docs/architecture.md` §8

## 5. Growth / CRM 向け decision_type（2026-09-23 追記・予約のみ・MA-31）

Vault 正本 `AI-Workflow-System/07_project-kits/AI開発環境改善マスタープラン_E-NEXUS-Growth-CRM-Automation-Layer構想_2026-09-23.md` §8 で確定した予約。Growth / CRM Automation Layer は Decision Layer の**外**（利用側）であり、Growth のロジックを本 repo に実装しない。ここでは decision_type の名前と境界だけを持つ。

| decision_type | 用途 | 境界（変えない） |
|---|---|---|
| `content-publish-gate` | **実装済み（G3・2026-09-23）**。outcome = publish_candidate / revision_needed / risk_level / human_review_required / recommended_route（human-publish-review / needs-revision / hold / blocked）。予約時の content_risk / duplicate_risk / brand・legal-risk / human_attention_candidate は risk_level・rules（already-published / duplicate-confirmed / risk_flags）・human_review_required へ写像した | 公開は Human-only（Safety台帳 L4/L5）。tier=auto は「投稿してよい」を意味しない。公開実行キーは `forbidden_outcome_keys` で禁止 |
| `channel-selection` | **実装済み（G3後半・2026-09-23）**。outcome = channel_status / content_channel_fit / human_review_required / recommended_route（channel-candidate-review / not-a-candidate / hold）。予約時の recommended_channels / channel_suitability は channel_status・content_channel_fit・rules（facebook/discord/linkedin・公開済み・有料listing・Human除外・未登録・opt-in・情報不足）へ写像した。**localization_value / video_conversion_value / repost_value / content_value は今回持たせていない**（variant生成・媒体別派生の判断は本 decision_type の対象外。発注書§8の候補列のうち今回のscope外） | 候補提示のみ（投稿しない）。planned / future / excluded の媒体（Vault 正本 §7）は rules で候補から外す。投稿実行キーは `forbidden_outcome_keys` で禁止 |
| `lead-triage` | **実装済み（2026-09-29・FB-04）**。outcome = lead_intent / lead_priority / service_fit / b2b_b2c / reply_classification / human_review_required。input は subject_ref（contact_ref）・状態・カテゴリ・件数・recency 区分だけ。rules＝consent・購読・spam・採用・苦情・メッセージ無し | `call-triage`（ai-phone）と併存。PII を input / context に入れない（reference ID と件数のみ）。`reply_classification=do-not-contact` は tier=human に固定 |
| `next-best-action` | nurture vs sales / next_best_action / cross_sell_fit | AI Company V1 §8 の補助。実行は Human |
| `customer-reply-gate` | **実装済み（2026-09-29・FB-04）**。outcome = reply_readiness（human-send-review / needs-revision / hold / do-not-send）/ tone_fit / risk_level / human_review_required。rules＝consent・購読・配信停止の申し出・spam・苦情・解約・価格／法務／約束／会社表明・個人情報・抜粋なし | AI Company V1 §9 の補助。送信は Human の署名付き承認（crm-core G5 executor）。`hold`・`do-not-send` は tier=human に固定 |
| `automation-safety-gate` | **実装済み（2026-09-29・FB-04）**。outcome = safety_class（low / elevated / escalate）/ human_review_required / automation_route（existing-gates / human-review / do-not-automate）。rules＝Secret・署名なしの有料API／外部送信・一括送信・承認なしの不可逆・rollback 無しの production 書き込み・守り不明・説明なし→escalate、G5 executor の形→low | `io-guard-assist` と同じ「怪しい → Escalate」のみ。解除・承認キーは `forbidden_outcome_keys` で禁止済み。`escalate`・`do-not-automate`・`human-review` は tier=human に固定 |

- 共通の context 命名規約（schema 変更なし。schema 化時に input へ昇格）：`source_product / event_type / subject_ref / channel / policy_context / consent_context / action_candidates / correlation_id`。PII は入れない
- Final Human Requirement は Jev 単独で決めない（Calibration の `human_review_required` = D の結論をそのまま適用。policy + consent + confidence + risk + frequency rules から Decision Layer が決定的に導く）
- deterministic policy（unsubscribe / consent / frequency cap / duplicate block / budget / permission / cooldown / external-send prohibition）は Jev に判断させず、Growth Core 側の policy JSON に置く（本 repo の `policies/` にも置かない）
- 予約しないもの：`sales-readiness` / `cross-sell-routing` / `churn-response`（sale・retention の実データが継続して出るまで）
- schema 化の順序：Vault 正本 §16 の G3（`content-publish-gate` → `channel-selection`、Rules First）。MA-30 follow-up ①②の後。本追記は MA-30 の状態（基盤完成 / Calibration 完了 / 次統合待ち）を変えない（→ 2026-09-29 の MA-30 の現在地は Vault 正本 §18-16。下の「実装へ進める条件」は 1〜3 が完了し、残りは 4＝各 use case を1件ずつ schema 化する時の順序だけ）
- 2026-09-23：`content-publish-gate`・`channel-selection` を実装（Human の明示発注により follow-up ①② 未着手のまま先行。decision-log 参照）。`lead-triage` 以降の 4 件は予約のまま
- 2026-09-29（Human発注「FULL AUTONOMOUS BUILD」・FB-04）：`automation-safety-gate`・`customer-reply-gate`・`lead-triage` を実働化（schema・rules・offline tests。実JEV Calibration は課金を伴うため Human go 待ち＝閾値は既定値のまま）。consumer は crm-core（入力写像 `src/decision/decision-inputs.mjs`）。`next-best-action` は予約のまま（consumer と入力の実データが無い）。enum 値で tier=human を強制する `force_human_when_outcome_values` を engine に追加

## 仕様に固定しない情報

レイテンシ（ms）・上位モデル比の速度／価格・hallucination 率・ベンチマーク順位・選択肢数上限・学習手法（RLCD 等）の詳細は**ベンダー公表値**であり変更され得るため、Decision Layer の仕様・閾値・chain には入れない。参考値を残す場合は出典付きで本 docs に置くだけにする。現時点で出典確認済みの値は無いため記録していない。

## 実装へ進める条件（この順を崩さない）

1. GitHub repo 作成＋push、skill-sync（Human-only） → **完了**（2026-09-19）
2. Jev 実API仕様・キー取得 → `direct` Provider 実装（`src/adapters/jev/jev-provider-interface.mjs` の契約内） → **完了**（2026-09-29 Direct 実疎通）
3. `paid-generation-gate` の本接続（OpenMontage wrapper）と usage.jsonl 実測 → **完了**（2026-09-26 OpenMontage 接続・usage 実測）
4. その後に本 docs の 1〜4 を1件ずつ schema 化（`reserved_decision_types` → `decision_types` へ移す）
