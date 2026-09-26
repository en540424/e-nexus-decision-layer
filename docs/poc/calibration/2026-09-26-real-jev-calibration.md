# 実JEV Calibration 第2回（2026-09-26）— channel-selection / content-publish-gate / paid-generation-gate

MA-30 Common Decision Gateway／JEV 共通接続 第1段クローズ後、実 Jev（Vercel AI Gateway・`typesafe-ai/jev`）の **Decision 品質** を
consumer 展開できる水準へ調整した記録。Gateway 方式・Common Contract・engine・閾値（0.85 / 0.60）は変更していない。
方針の正本は Vault MA-30 正本 §18、決定の理由は `docs/decision-log.md` 2026-09-26 の行。本書は実測の一次記録。

## 1. 評価セット（synthetic・PII なし）

| type | 評価（Jev 到達） | Rules First 確認 | holdout（修正前に凍結・1回だけ実行） | ファイル |
|---|---|---|---|---|
| channel-selection | 12 | 5 | 3 | `channel-selection.cases.json` / `.holdout.cases.json` |
| content-publish-gate | 12 | 5 | 3 | `content-publish-gate.cases.json` / `.holdout.cases.json` |
| paid-generation-gate | 12 | 2 | 3 | `paid-generation-gate.v2.cases.json` / `.v2.holdout.cases.json` |

- expected は唯一の正解ではなく **制約**：`acceptable`（field ごとの許容値集合）・`unacceptable`（事実・方針と衝突する値）。
- 自己矛盾は outcome schema の `x-outcome-invariants` で数える（rules の全 outcome が満たすことを tests で固定）。
- holdout は commit `81996f6`（修正前）で凍結し、修正の設計には使っていない。
- 評価器：`scripts/poc-calibration.mjs`（`--cases` / `--label` / 制約評価 / `analyze --compare`）。結果 JSON は `results/*-cal2-*.json`。

## 2. 原因（baseline で確認）

| type | 観測 | 原因 |
|---|---|---|
| channel-selection | 登録済みの `note` を `unavailable` と判定（前回 smoke と同型）、情報の薄いケースで `internal`。12/12 で `human_review_required` が全体 min を決めた | ① Rules First 通過後には到達し得ない選択肢（excluded / future / internal / unavailable・fit none・route hold）まで Jev に提示していた ② Jev は `note` が note.com（日本語の長文プラットフォーム）だと分からず媒体として評価できなかった ③ route を status と独立に訊いており自己矛盾し得た |
| content-publish-gate | 11/12 合格・矛盾 1（`publish_candidate=true` かつ修正要）。明確なケースも全件 human | `publish_candidate` は `route=human-publish-review` と同義なのに別質問だった／`human_review_required`・`revision_needed` の boolean 確信度（\|2p−1\|）が min を決めた |
| paid-generation-gate | 12/12 合格・矛盾 0（前回 smoke の矛盾は曖昧な purpose の入力で発生）。全件 human | `human_review_required` と、route に効かない補助 boolean（`remotion_suitable`：「向いているか」と「作れるか」の混同）が min を決めた |

## 3. 変更（Jev Adapter の汎用機構＋schema 宣言。decision_type 固有分岐なし）

| 機構 | 内容 | 適用 |
|---|---|---|
| `x-jev-enum` | Rules First 通過後に到達し得る選択肢だけを提示。隠す値はすべて rules の outcome に現れること（rule coverage）を tests で固定 | channel-selection：status＝primary/secondary/not_recommended、fit＝high/medium/low |
| `x-jev-derive` | 定義上ほかの field で決まる field は訊かずに写像（判断は元 field で Jev がする） | channel route ← status、content-publish `publish_candidate` ← route |
| `x-jev-brief` | Jev の段で成り立っている前提（Rules First 通過済み等）を含む brief | channel-selection / content-publish-gate |
| `input_notes` | input enum 値の意味を schema の固定文から添える（input 由来の情報は増やさない） | `channel`（note = note.com 等） |
| `x-boolean-criteria` | Vercel boolean criteria（true / false の意味）。Direct には送らない | 3 type の `human_review_required`、`revision_needed`、`local_sufficient`、`remotion_suitable` |
| `x-outcome-invariants` | 自己矛盾した回答は confidence 0（usage は attempt に保持）→ human | 3 type（paid＝7・channel＝7・content＝6 件） |
| `x-jev-confidence: escalation-only` | **follow-up ② Hybrid**：`human_review_required` は true なら常に human（forcedHumanKey）、確信度は min に入れない | 3 type の `human_review_required` |
| rule 追加 | `risk_flags.confidential_or_secret`（Secret・外部公開禁止情報）→ hold / high / human review。Jev に本文を見せない | content-publish-gate |
| 定義の明確化 | `local_sufficient` / `remotion_suitable` を「能力（作れるか）」の問いに | paid-generation-gate |

## 4. 結果（Jev 到達ケースのみ。confidence は attempt の値）

| type | run | 制約合格 | 矛盾 | confidence min / median / mean | 最終 tier auto / review / human | 不要 Human（明確ケース） | 必要 Human 維持 |
|---|---|---|---|---|---|---|---|
| channel-selection | baseline | 9/12 | 1 | 0.06 / 0.44 / 0.41 | 0 / 3 / 9 | 7/10 | — |
| | improved1 | 12/12 | 0 | 0.14 / 0.72 / 0.65 | 0 / 10 / 2 | 0/10 | — |
| | improved2 | 12/12 | 0 | 0.34 / 0.99 / 0.90 | 10 / 0 / 2 | 0/10 | — |
| | **holdout** | **3/3** | 0 | 0.96 / 0.98 / 0.98 | 3 / 0 / 0 | 0/3 | — |
| content-publish-gate | baseline | 11/12 | 1 | 0.02 / 0.27 / 0.22 | 0 / 0 / 12 | 4/4 | 4/4 |
| | improved1 | 12/12 | 0 | 0.04 / 0.34 / 0.41 | 0 / 0 / 12 | 4/4 | 4/4 |
| | improved2 | 12/12 | 0 | 0.40 / 0.65 / 0.64 | 0 / 3 / 9 | 2/4 | 4/4 |
| | **holdout** | **3/3** | 0 | 0.58 / 0.68 / 0.66 | 0 / 1 / 2 | 1/2 | 1/1 |
| paid-generation-gate | baseline | 12/12 | 0 | 0.02 / 0.21 / 0.27 | 0 / 0 / 12 | 9/9 | 1/1 |
| | improved1 | 12/12 | 0 | 0.02 / 0.39 / 0.36 | 0 / 0 / 12 | 9/9 | 1/1 |
| | improved2 | 12/12 | 0 | 0.08 / 0.78 / 0.66 | 2 / 7 / 3 | 0/9 | 1/1 |
| | **holdout** | **3/3** | 0 | 0.12 / 0.57 / 0.50 | 0 / 1 / 2 | 1/2 | 1/1 |

「不要 Human」＝ambiguity low かつ Human 必須でないケースが最終 human になった数。「必要 Human」＝acceptable が `human_review_required=true` または route `human-review` だけのケース。

### 4-1. 改善の内訳（§49-D：数値を持ち上げただけではないか）

旧合成（全 field の min。Hybrid 無し）で同じ回答を評価した mean と、新合成（Hybrid）での mean：

| type | 旧合成 baseline → improved2 | 新合成 improved2 |
|---|---|---|
| channel-selection | 0.41 → 0.67 | 0.90 |
| content-publish-gate | 0.22 → 0.42 | 0.64 |
| paid-generation-gate | 0.27 → 0.37 | 0.66 |

- **field 単位の品質向上（旧合成の上昇分）**：channel-selection の status / fit が 0.47〜0.79 → 0.89〜1.00、`note` の誤判定解消、矛盾 2 → 0、合格 32/36 → 36/36。
- **合成の変更（Hybrid）による上昇分**：残り（例：channel-selection の review → auto はほぼこちら）。Jev の回答が良くなったのではなく、`human_review_required` の確信度を min から外した効果。true の答えは常に human に固定したまま。
- 不要 Human の残り：content-publish-gate の CP-J7 / J9（`human_review_required=true` が p≈0.52〜0.56 で立ち human 固定。安全側）、holdout CP-H1（`revision_needed` の確信度 0.58）・PG-H2（route 0.57）。

### 4-2. 合成方法の代替案（採用しない・Human 判断候補）

「判断 field（route 等）だけで min、補助 field は不変条件だけで縛る」合成なら CP-J1/J2/J8・PG-J1/J3 も auto になる（improved1 データでの試算）。
ただし field の役割をこの評価データを見た後で決めることになり、2026-09-19 に alt aggregate を却下した経緯（decision-log）とも衝突するため**実装しない**。
採否は本番入力の実測が溜まってから Human が判断する。

## 5. 実 JEV 呼び出し・コスト・latency

- 実 Jev 呼び出し：評価 108（36 × 3 run）＋ holdout 9 ＋ consumer smoke 3 = **120 回**（すべて `networked:true`・route vercel・失敗 0）
- 推定コスト合計：評価と holdout で 7,552 USD micros（≈ 0.0076 USD。registry の input 単価から推定。1 判定 ≈ 55〜76 USD micros）
- latency：median 460〜525ms。外れ値 1 件 59.2s（PG-J12 improved2。応答は正常。成功時は SDK 内部の再試行回数を観測できない）。本番は Gateway の 30s timeout で fail-closed（human-required）になる
- 1 判定あたりの input tokens は narrowing と derive で減少（channel-selection 21,918 → 16,134 / 12 件）

## 6. consumer 実経路 smoke（Gateway 経由・証跡）

| consumer | request_id | 結果 |
|---|---|---|
| claude-code（CLI・channel-selection・架空 dev-log × note・登録済み） | `req_e4d523ff-3522-4cc7-afa2-a785c09dd8fa` | jev・primary / high / channel-candidate-review・conf 0.71・review（前回同型は unavailable / hold・conf 0） |
| en-generate-hub（`decision-gate`・scratchpad コピー・人名なし purpose） | `req_df2b6257-…` / `req_b4d13909-8fad-4b3d-8a64-9bb594cafb42` | jev・paid=true・route en-generate-hub（矛盾なし）・conf 0.66 / 0.68・review。run / approve / submit なし |

`scripts/real-jev-evidence.mjs --since 2026-09-26T03:10:00Z --expect claude-code,en-generate-hub` → exit 0。

## 6-1. Gateway は Jev への入力を劣化させない（§28）

`tests/gateway-real-jev-path.test.mjs`「Gateway does not degrade what Jev receives」：Gateway の `decide` → production と同じ adapter 並び → Vercel provider の受信引数で、`state.input` が consumer の `input` と完全一致（boolean は boolean のまま・field の欠落／改名なし）、`input_notes`・絞った選択肢・導出 route が届くことを確認（tests 240/240）。

## 7. 残り・次

- 本番入力の分布は synthetic と違う。consumer 接続後に usage.jsonl の attempts で confidence・tier を継続観測する
- en-generate の `purpose` は依頼の経緯（Provider 比較等）が入りやすく asset の説明になっていないことがある（前回 smoke の低 confidence の一因）。consumer 側で asset の短い説明を渡す改善は en-generate-hub 側の別作業
- `revision_needed` の確信度が明確ケースでも 0.5〜0.6 に留まることがある（content-publish-gate の残る不要 Human の主因）
