# content-publish-gate（MA-31 G3・2026-09-23）

外部公開前のコンテンツ 1 件 × 1 媒体について「次にどの段階へ進めるか」を型付きで返す**公開前判定ゲート**。
**公開実行装置ではない。** note / X / Threads / YouTube / Instagram / TikTok / TALES / Substack / Medium / Pinterest / pixiv への公開は、
tier や route に関わらず常に Human が行う（Safety台帳§2 L4/L5・`policies/safety/human-only.json` の `external-send-approval`）。

Vault 正本：`AI-Workflow-System/07_project-kits/AI開発環境改善マスタープラン_E-NEXUS-Growth-CRM-Automation-Layer構想_2026-09-23.md` §8・§16（G3）。

## 1. 位置づけ（G2 との順序）

```
Draft / Variant（Vault・note系Skill・en-sns-hub）
  ↓
content-publish-gate（本 decision_type。判定のみ）
  ↓
Human review / Human publish（Decision Layer の外。承認・実行は Human）
  ↓
Publication → content_published（G2。note-publish Skill → Product Hub 送信箱）
  ↓
metric_recorded（G2）
```

本ゲートは `content_published` を発火しない・Hub へ書かない・外部へ送らない。新しい execution layer・Event Bus・Channel Registry は作らない（Execution Contract は G5）。

## 2. schema（`schemas/growth/content-publish-gate.schema.json`）

**input（閉じている：`additionalProperties:false`）**。input 全体が Jev の `state.input` に載るため、本文全文・氏名・メール・電話・住所・顧客個人情報を入れる経路を schema で塞ぐ。自由文は `title`(≤200) / `summary`(≤600) / `excerpt`(≤1200、redaction 済み抜粋) だけ（validator に `maxLength` を追加）。

| field | 必須 | 内容 |
|---|---|---|
| `content_id` | ✔ | 参照ID（Hub content id・Vault 相対パス等）。PII なし |
| `channel` | ✔ | 媒体名（14種。状態は Vault 正本§7 が正本） |
| `channel_registered` | ✔ | Hub に実物 channel（`chn_*`）があるか（planned 媒体は false） |
| `prior_publication_state` | ✔ | `unpublished` / `published` / `unknown` |
| `source_type` / `content_type` / `language` / `provenance` | | 由来・Hub `content.kind` 相当・作成者区分 |
| `duplicate_confirmed` / `policy_state` / `review_state` / `human_opt_in` | | caller 確認済みの事実 |
| `risk_flags.{personal_information, identifiable_third_party, legal_or_financial_claim, company_representative_statement, sale_terms}` | | caller が検出したリスク信号 |
| `campaign_ref` / `project_ref` | | 参照ID |

**outcome（5 field。すべて Jev question に写像できる型のみ）**

| field | 型 | 意味 |
|---|---|---|
| `publish_candidate` | boolean | そのまま Human の公開判断へ渡せるか。**true でも自動公開してよい意味ではない** |
| `revision_needed` | boolean | 本文の修正が先に要るか |
| `risk_level` | `low` / `medium` / `high` / `unassessed` | 公開した場合の害（brand / legal / privacy / reputational）。`unassessed`＝本文を評価する前に止めた／情報不足 |
| `human_review_required` | boolean | **内容に特定の懸念があり Human が焦点を当てて確認すべきか**。「公開に Human 承認が要るか」（常に要る）とは別。true なら既存 `force_human_when_outcome_keys` で tier=human |
| `recommended_route` | `human-publish-review` / `needs-revision` / `hold` / `blocked` | 次の処理段階。どの値も公開を意味しない |

reason code 専用 field は置かない（Jev が全 field に答える設計のため rules 専用の field を作れない）。決定的な理由は `rationale` の `rule:<id>` で機械可読に返る。

## 3. deterministic rules（`policies/routing/rules/content-publish-gate.json`、Jev に聞かない）

上から first-match、confidence 1.0。

| 順 | rule id | 条件 | route |
|---|---|---|---|
| 1 | `channel-facebook-excluded` | channel=facebook | blocked |
| 2 | `channel-discord-internal` | channel=discord（External Channel ではない） | blocked |
| 3 | `channel-linkedin-future` | channel=linkedin | blocked |
| 4 | `already-published` | prior_publication_state=published | blocked |
| 5 | `duplicate-confirmed` | duplicate_confirmed=true | blocked |
| 6 | `policy-state-blocked` | policy_state=blocked | blocked |
| 7 | `channel-not-registered` | channel_registered=false | hold |
| 8 | `publication-state-unknown` | prior_publication_state=unknown | hold |
| 9–12 | `{x,threads}-opt-in-{missing,false}` | X / Threads で human_opt_in が true でない | hold |
| 13 | `personal-information` | risk_flags.personal_information | needs-revision（human_review_required=true） |
| 14–17 | `legal-or-financial-claim` / `company-representative-statement` / `identifiable-third-party` / `sale-terms` | 各 risk flag | hold（human_review_required=true） |
| 18 | `review-issues-open` | review_state=issues-open | needs-revision |
| 19–20 | `title-missing` / `summary-missing` | 欠落 | needs-revision |

- rules が持つのは「caller が渡した事実 → outcome」の写像だけ。consent / cooldown / frequency cap / 公開停止リスト等の **policy の状態は持たない**（Growth Core 側 policy JSON、G4）
- 名前で止めるのは方針が固定済みの 3 媒体（facebook / linkedin / discord）だけ。planned / manual は時間で変わるため caller の `channel_registered` で判定し、Vault 正本§7 の表を複製しない
- rules は `human-publish-review` を出さない（公開候補の判定は内容を読む Jev / Human 側）。`tests/content-publish-gate.test.mjs` が表全体を schema と route 整合で検査する

## 4. Jev question design（MA-30 Calibration 方式）

- 各 outcome field の `description` = question instructions（具体的な判定基準を列挙）、enum 値ごとの `x-enum-descriptions` = choice criteria、outcome の `description` = `state.brief`（公開しない・承認ではないことを明記）
- 特定の答えへ誘導する文言を書かない（steering 語句をテストで機械検査）
- `human_review_required` は Calibration で limiting field になった経緯（MA-30 分類 D）を踏まえ、「人が見るべきか」という抽象的な問いではなく**観察可能なトリガー**（特定可能な第三者・法務/医療/税務/金融の主張・会社代表の表明・価格/販売条件・個人情報・検証不能な事実）で定義した。caller がフラグで分かっているものは rules が決定的に true にする
- confidence 合成（min）・閾値（0.85 / 0.60）は**変更していない**。field 数は 5（paid-generation-gate と同数）に抑えた
- **MA-30 follow-up ②（`human_review_required` の Hybrid 化：Jev＋policy＋他 field confidence＋矛盾検出から決定的に導く）は未実装のまま**。route と他 field の矛盾検出もその範囲

## 5. Human-only publish の扱い（別レイヤで分離）

| 層 | 何を表すか | 置き場 |
|---|---|---|
| 公開前判定 | 次の処理段階（本 decision_type） | outcome / tier |
| 内容の要注意 | 特定の懸念があるか | `outcome.human_review_required`（true → tier=human） |
| 公開の承認・実行 | 常に Human | `human_only_decision_types` の `external-send-approval`、Safety台帳§2。Decision Layer は返さない |

- `forbidden_outcome_keys` に `publish_now` / `auto_publish` / `publish_approved` / `publish_allowed` / `allow_publish` / `post_now` を追加（outcome に現れたら `HumanGateViolationError`）
- `decision-types.json` の entry に `final_action: "human-only"` を宣言（engine は読まない。docs / tests 用）
- **tier=auto ＋ `human-publish-review` は「この事前判定に確信がある」であって公開許可ではない**（paid-generation-gate の「tier=auto は承認ではない」と同じ意味論。tests で固定）

## 6. fallback / metering

既存 chain（`rules → jev → [mock-jev] → local → llm → human`）をそのまま使う。

- mock-jev に content-publish-gate のヒューリスティックは**置かない** → `supports()` が false で chain から外れる（`UNSUPPORTED`）。キー無し／Network Gate OFF では `rules → jev(KEY_MISSING / NETWORK_DISABLED) → local → llm → human` の escalation になる。模擬判定が公開ゲートを通すことはない
- 実 Jev が使えるときの mock 除外（`realJevUsable`）は無変更
- metering は既存の `attempts[]` / `usage_total`（provider / model / route / confidence / latency_ms / tokens / cost / networked / retry_count / fallback trace）をそのまま使う

## 7. Human smoke（実 Jev。Human Required）

実 Jev キーは Human のシェルにしか無いため、本実装の Jev 経路は注入した fake provider でのみ検証済み（実通信は未実施）。Human が実疎通を確認する場合：

```powershell
$env:JEV_PROVIDER="vercel"; $env:EDL_ALLOW_NETWORK="true"   # AI_GATEWAY_API_KEY は既に設定済みのシェルで
node src/cli.mjs decide --file docs/growth/content-publish-gate.sample-request.json
```

1 リクエスト＝5 question。burst しない（MA-30 で 429 を観測済み）。結果の `resolved_by` / `tier` / `fallback.trace[jev].confidence` を確認するだけで、公開・Hub 反映は何も起きない。

## 8. やっていないこと

外部公開・自動投稿・SNS API 接続・`content_published` 発火・Execution Contract（G5）・`channel-selection` 以降の Growth decision_type（予約のまま）・TypeSafe Direct 対応・閾値／合成方式の変更・Common Event Layer・新 Channel Registry。
