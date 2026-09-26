# channel-selection（MA-31 G3後半・2026-09-23）

コンテンツ 1 件 × 候補媒体 1 件について「この媒体を distribution candidate として進めるべきか」を型付きで返す**候補選定ゲート**。
**投稿実行装置ではない。** note / X / Threads / YouTube / Instagram / TikTok / TALES / Substack / Medium / Pinterest / pixiv への投稿は、
tier や route に関わらず常に Human が行う（Safety台帳§2 L4/L5・`policies/safety/human-only.json` の `external-send-approval`）。

Vault 正本：`AI-Workflow-System/07_project-kits/AI開発環境改善マスタープラン_E-NEXUS-Growth-CRM-Automation-Layer構想_2026-09-23.md` §8・§16（G3後半・§16-3）。

## 1. 位置づけ（content-publish-gate との責務分離）

```
Draft / Variant（Vault・note系Skill・en-sns-hub）
  ↓
channel-selection（本 decision_type。「どの媒体が候補か」だけを判定）
  ↓
候補チャネル（channel-candidate-review の媒体だけ）
  ↓
content-publish-gate（各候補チャネルごとに公開readiness / risk を判定）
  ↓
Human review / Human publish（Decision Layer の外。承認・実行は Human）
  ↓
Publication → content_published（G2）→ metric_recorded（G2）
```

一度の decide() 呼び出しは「1 content × 1 候補媒体」を評価する（content-publish-gate と同じ粒度）。複数媒体を検討する場合は候補媒体ごとに呼び出し、結果を呼び出し側（Claude Code 本体）で集約する。**媒体を跨いだ配列 outcome は持たない**：Jev Adapter が outcome の各 field を boolean / enum に写像する設計（`buildJevRequest`）上、object・array 型の outcome field は `JEV_UNSUPPORTED_OUTCOME_FIELD` になり engine 変更なしに実現できないため（content-publish-gate と同一 Adapter 実装を無変更で使う制約）。

本ゲートは投稿しない・`content_published` を発火しない・Hub へ書かない・外部へ送らない。新しい execution layer・Event Bus・Channel Registry は作らない（Execution Contract は G5）。

**channel-selection と content-publish-gate の役割分担**

| | channel-selection | content-publish-gate |
|---|---|---|
| 問い | この媒体は候補か | この content/channel の組合せは公開に進めてよいか |
| risk 判定 | しない | する（`risk_level`） |
| revision 判定 | しない | する（`revision_needed`） |
| 媒体方針（facebook/linkedin/discord） | rules で候補から外す | rules で公開候補から外す（同じ3媒体を同じ理由で） |
| 出力 | `channel_status` / `content_channel_fit` / `recommended_route` | `publish_candidate` / `risk_level` / `recommended_route` |

## 2. schema（`schemas/growth/channel-selection.schema.json`）

**input（閉じている：`additionalProperties:false`）**。自由文は `title`(≤200) / `summary`(≤600) / `excerpt`(≤1200、redaction 済み抜粋) だけ（content-publish-gate と同じ validator の `maxLength`）。

| field | 必須 | 内容 |
|---|---|---|
| `content_id` | ✔ | 参照ID。PII なし |
| `channel` | ✔ | 評価対象の候補媒体名（14種。状態は Vault 正本§7 が正本） |
| `channel_registered` | ✔ | Hub に実物 channel（`chn_*`）があるか（planned 媒体は false） |
| `channel_publication_state` | ✔ | `not-published` / `published` / `unknown`（この channel での既公開状態） |
| `source_type` / `content_type` / `media_type` / `language` | | 由来・Hub `content.kind` 相当・主形態（text/image/video/audio/mixed）・言語 |
| `title` / `summary` / `excerpt` | | Jev の soft judgment（fit 判断）に使う最小限の自由文 |
| `paid_listing` | | true なら有料 listing（note 有料記事等）で content flow の対象外 |
| `human_opt_in` | | X / Threads のみ：Human の明示 opt-in |
| `human_channel_preference` | | `preferred` / `excluded` / `none`：Human のこの媒体への明示意向 |
| `campaign_ref` / `project_ref` | | 参照ID |

**outcome（4 field。すべて Jev question に写像できる型のみ）**

| field | 型 | 意味 |
|---|---|---|
| `channel_status` | `primary` / `secondary` / `not_recommended` / `excluded` / `future` / `internal` / `unavailable` | この媒体の立ち位置。primary/secondary は「候補として進める」、not_recommended/excluded/future/internal は「進めない」、unavailable は「まだ判断できない」 |
| `content_channel_fit` | `high` / `medium` / `low` / `none` | content_type / media_type / title / summary / excerpt から見た媒体適合度。`none`＝内容を読む前に rules が決定的理由で止めた |
| `human_review_required` | boolean | **このcontent×channelの組合せに焦点確認が要るか**（fit が曖昧・content type が媒体にとって異例・signal が矛盾）。「投稿に Human 承認が要るか」（常に要る）とは別。true なら既存 `force_human_when_outcome_keys` で tier=human |
| `recommended_route` | `channel-candidate-review` / `not-a-candidate` / `hold` | 次の処理段階。`channel_status` から決定的に導ける（primary/secondary→review、not_recommended/excluded/future/internal→not-a-candidate、unavailable→hold） |

reason code 専用 field は置かない。決定的な理由は `rationale` の `rule:<id>` で機械可読に返る（content-publish-gate と同じ設計）。

## 3. deterministic rules（`policies/routing/rules/channel-selection.json`、Jev に聞かない）

上から first-match、confidence 1.0。

| 順 | rule id | 条件 | channel_status | route |
|---|---|---|---|---|
| 1 | `channel-facebook-excluded` | channel=facebook | excluded | not-a-candidate |
| 2 | `channel-discord-internal` | channel=discord（External Channel ではない） | internal | not-a-candidate |
| 3 | `channel-linkedin-future` | channel=linkedin | future | not-a-candidate |
| 4 | `channel-publication-state-published` | channel_publication_state=published | excluded | not-a-candidate |
| 5 | `human-channel-excluded` | human_channel_preference=excluded | excluded | not-a-candidate |
| 6 | `paid-listing-out-of-scope` | paid_listing=true | excluded | not-a-candidate |
| 7 | `channel-not-registered` | channel_registered=false | unavailable | hold |
| 8 | `channel-publication-state-unknown` | channel_publication_state=unknown | unavailable | hold |
| 9–12 | `{x,threads}-opt-in-{missing,false}` | X / Threads で human_opt_in が true でない | unavailable | hold |
| 13–14 | `title-missing` / `summary-missing` | 欠落 | unavailable | hold |
| 15 | `human-channel-preferred` | human_channel_preference=preferred（ここまでの rule に一致しなかった場合のみ到達） | primary | channel-candidate-review |

- rules が持つのは「caller が渡した事実 → outcome」の写像だけ。Growth Core 側 policy（consent / cooldown / frequency cap 等）は持たない（G4）
- 名前で止めるのは方針が固定済みの 3 媒体（facebook / linkedin / discord）だけ。planned / manual は時間で変わるため caller の `channel_registered` で判定し、Vault 正本§7 の表を複製しない
- `human-channel-preferred` は Human の明示指定を尊重して `primary` を返す唯一の rule だが、**評価順は情報不足チェックより後ろ**に置いている。policy block（facebook 等）・公開済み・有料listing・未登録・opt-in無し・title/summary欠落のいずれかに既に該当していれば先にそちらで止まる（**Human preference は policy block も情報不足も突破しない**。MA-31 正本§10。tests「ordering invariant」で固定）
- rules は `content_channel_fit` を常に `none`（未評価）で返す。`human-channel-preferred` も例外ではない：Human の明示指定は尊重して `channel_status=primary` にするが、内容を読んで fit を判断したわけではないため `content_channel_fit` は `none` のまま

## 4. Jev question design（MA-30 Calibration 方式）

- 各 outcome field の `description` = question instructions、enum 値ごとの `x-enum-descriptions` = choice criteria、outcome の `description` = `state.brief`（投稿を選ばない・公開承認ではない・content-publish-gate とは別の判定であることを明記）
- 特定の答えへ誘導する文言を書かない（steering 語句をテストで機械検査。content-publish-gate と同じチェック）
- `human_review_required` は content-publish-gate と同じ設計思想（観察可能なトリガーで定義）を、fit 判定という別ドメインに適用：fit が曖昧・content type が媒体にとって異例・signal が矛盾、のいずれか
- 閾値（0.85 / 0.60）は**変更していない**。2026-09-26 実JEV Calibration で `human_review_required` を escalation-only（true なら常に human・確信度は min に入れない。follow-up ② Hybrid）にした。field 数は 4（content-publish-gate の 5 より少ない。channel_status と recommended_route の一部が重複する情報を持つため content_channel_fit を追加してもなお content-publish-gate 以下に収めた）
- **（2026-09-26 解消）旧・既知のギャップ**：`recommended_route` は Jev に訊かず `channel_status` から導出（`x-jev-derive`）するため status と route は矛盾し得ない。status × fit の矛盾（primary × low 等）は `x-outcome-invariants` で検知し confidence 0 → human。Jev に提示する選択肢は Rules First 通過後に到達し得る値（status＝primary / secondary / not_recommended、fit＝high / medium / low）だけ（`x-jev-enum`）。媒体の意味は `input_notes`（`channel` の `x-enum-descriptions`）で渡す。実測は `docs/poc/calibration/2026-09-26-real-jev-calibration.md`

## 5. Human-only publish の扱い（別レイヤで分離）

| 層 | 何を表すか | 置き場 |
|---|---|---|
| 候補選定 | この媒体を候補として進めるか（本 decision_type） | outcome / tier |
| content×channel の要注意 | fit に焦点確認が要るか | `outcome.human_review_required`（true → tier=human） |
| 投稿の承認・実行 | 常に Human | `human_only_decision_types` の `external-send-approval`、Safety台帳§2。Decision Layer は返さない |

- `forbidden_outcome_keys` は content-publish-gate が追加した 6 種（`publish_now` 等）をそのまま再利用する。本 decision_type の outcome field 名（`channel_status` / `content_channel_fit` / `human_review_required` / `recommended_route`）とその enum 値のいずれも該当しないため、`human-only.json` への追加は不要（tests で機械検査）
- `decision-types.json` の entry に `final_action: "human-only"` を宣言（engine は読まない。docs / tests 用）
- **tier=auto ＋ `channel-candidate-review` は「この候補判定に確信がある」であって投稿許可ではない**（content-publish-gate の「tier=auto は承認ではない」と同じ意味論。tests で固定）
- **caller は `recommended_route` で次の段階を決め、`human_gate.required` では決めない**：rules の `not-a-candidate` / `hold`（policy block・未登録・opt-in無し・有料listing等）は fit の懸念が無いので tier=auto・`human_gate.required=false` で返る。「進めない」という意味は route が持つ（tests で固定。content-publish-gate と同じ意味論）

## 6. fallback / metering

既存 chain（`rules → jev → [mock-jev] → local → llm → human`）をそのまま使う。

- mock-jev に channel-selection のヒューリスティックは**置かない** → `supports()` が false で chain から外れる（`UNSUPPORTED`）。キー無し／Network Gate OFF では `rules → jev(KEY_MISSING / NETWORK_DISABLED) → local → llm → human` の escalation になる
- 実 Jev が使えるときの mock 除外（`realJevUsable`）は無変更
- metering は既存の `attempts[]` / `usage_total`（provider / model / route / confidence / latency_ms / tokens / cost / networked / retry_count / fallback trace）をそのまま使う

## 7. Human smoke（実 Jev。Human Required）

実 Jev キーは Human のシェルにしか無いため、本実装の Jev 経路は注入した fake provider でのみ検証済み（実通信は未実施）。Human が実疎通を確認する場合：

```powershell
$env:JEV_PROVIDER="vercel"; $env:EDL_ALLOW_NETWORK="true"   # AI_GATEWAY_API_KEY は既に設定済みのシェルで
node src/cli.mjs decide --file docs/growth/channel-selection.sample-request.json
```

1 リクエスト＝4 question。burst しない（MA-30 で 429 を観測済み）。結果の `resolved_by` / `tier` / `fallback.trace[jev].confidence` を確認するだけで、投稿・Hub 反映は何も起きない。

## 8. やっていないこと

外部公開・自動投稿・SNS API 接続・`content_published` 発火・Execution Contract（G5）・`lead-triage` 以降の Growth decision_type（予約のまま）・複数媒体を1回answerで返す配列 outcome（Jev Adapter の制約。§1参照）・TypeSafe Direct 対応・閾値／合成方式の変更・Common Event Layer・新 Channel Registry・content-publish-gate の再設計。
