# 拡張 Calibration（第3回・2026-09-29）— 実装済み／実 run は Human 待ち（BLOCKED）

発注：Fable 追加レビュー P（TypeSafe 公式 Skill × E-NEXUS Decision Layer 独立監査）の S1〜S5。拡張 run（約 300 回・既存 Vercel 経路・概算約 0.02 USD）は Human 承認済み。
**閾値（0.85 / 0.60）・chain・Contract v1・Human-only・型別 confidence 合成は変更しない。** 結果が悪くてもその場で閾値を変えない。

## 1. 状態

| 項目 | 状態 |
|---|---|
| S2 実版・probabilities の記録 | 実装済み（offline test） |
| S3 Direct の noul criteria | 実装済み（offline test。Direct 鍵は招待待ちのため実疎通なし） |
| S4 再抽選一致率・順序入替 variant・敵対 holdout | 実装済み（offline test） |
| S5 拡張 run | **BLOCKED（Human Required）**。Vercel AI Gateway が 403 を返す |

### 1-1. 403 の中身（2026-09-29 08:55 JST・runner 1 件で停止）

- `results/20260928T235507Z-cal3-precheck-paid-generation-gate.v2.json`：`PG-J2` 1 件目で `JEV_FORBIDDEN` → STOP_REASONS で即停止（ループなし）
- 診断（allowlist・本文やキーは保存しない）：`status 403`／外側 `GatewayInternalServerError`・`internal_server_error`／**内側 `RestrictedModelsError`・`no_providers_available`**／`resolved_provider: digitalocean`（`typesafe-ai` は fallback 候補）
- エラー本文の要旨（保存はしていない）：Vercel の無料枠ユーザーはこのモデルにアクセスできない。有料クレジットへ upgrade せよ
- `usage_known: false`（課金の有無は応答から分からない）。Gateway 応答上は provider attempt 0 件
- 直前の成功：2026-09-26 17:28 JST（openmontage）。それ以降の networked Jev 呼び出しはこの 1 件だけ
- 別に、原因切り分けのため Claude Code が scratchpad から AI SDK を直接 1 回呼んだ（Gateway を通さない診断。同じ 403・キー値は非表示）。以後の実通信は runner に限定した

**Human Required**：Vercel AI Gateway のクレジット／プラン確認（有料クレジット追加は課金操作＝Human-only）。09-26 までは同じキー・同じ経路で通っていた。変わった点は「無料枠ユーザーはモデル制限」の応答と、`typesafe-ai/jev` が `digitalocean` へ解決されること。

## 2. 解除後に流す run（このまま実行してよい・合計 約 243 回）

前提：Human のクレジット確認後。シェルに `AI_GATEWAY_API_KEY`・`JEV_PROVIDER=vercel`・`EDL_ALLOW_NETWORK=true`（User scope に設定済み）。1 件目で 403 が続くなら runner が即停止する。

| run | 内容 | 回数 |
|---|---|---|
| `cal3-repeat-*` | 既存 36 Jev ケース × `--repeat 5`（Rules First は 1 回） | 180 |
| `cal3-reordered-*` | 同 36 ケース × `--questions reordered`（選択肢と question の並びだけ逆） | 36 |
| `cal3-adversarial-*` | 敵対 holdout 9 ケース × `--repeat 3` | 27 |

```
node scripts/poc-calibration.mjs run --questions improved  --cases docs/poc/calibration/channel-selection.cases.json          --repeat 5 --label cal3-repeat-channel-selection
node scripts/poc-calibration.mjs run --questions improved  --cases docs/poc/calibration/content-publish-gate.cases.json       --repeat 5 --label cal3-repeat-content-publish-gate
node scripts/poc-calibration.mjs run --questions improved  --cases docs/poc/calibration/paid-generation-gate.v2.cases.json    --repeat 5 --label cal3-repeat-paid-generation-gate.v2
node scripts/poc-calibration.mjs run --questions reordered --cases docs/poc/calibration/channel-selection.cases.json                     --label cal3-reordered-channel-selection
node scripts/poc-calibration.mjs run --questions reordered --cases docs/poc/calibration/content-publish-gate.cases.json                  --label cal3-reordered-content-publish-gate
node scripts/poc-calibration.mjs run --questions reordered --cases docs/poc/calibration/paid-generation-gate.v2.cases.json               --label cal3-reordered-paid-generation-gate.v2
node scripts/poc-calibration.mjs run --questions improved  --cases docs/poc/calibration/channel-selection.adversarial.cases.json    --repeat 3 --label cal3-adversarial-channel-selection
node scripts/poc-calibration.mjs run --questions improved  --cases docs/poc/calibration/content-publish-gate.adversarial.cases.json --repeat 3 --label cal3-adversarial-content-publish-gate
node scripts/poc-calibration.mjs run --questions improved  --cases docs/poc/calibration/paid-generation-gate.v2.adversarial.cases.json --repeat 3 --label cal3-adversarial-paid-generation-gate.v2
```

Rules First ケース（CS-R* / CP-R* / PG-R*）は Jev を呼ばない（課金 0）ので回数に入れていない。

## 3. 分析

```
node scripts/poc-calibration.mjs analyze docs/poc/calibration/results/<cal3-repeat-…>.json
node scripts/poc-calibration.mjs analyze docs/poc/calibration/results/<cal3-reordered-…>.json --compare docs/poc/calibration/results/<cal3-repeat-…>.json
node scripts/poc-calibration.mjs analyze docs/poc/calibration/results/<cal3-adversarial-…>.json
```

見るもの：

| 指標 | 意味 | 合格の目安（閾値変更の根拠にはしない） |
|---|---|---|
| model_version seen | 実版が応答から取れたか（取れなければ `(null)`＝Vercel 経路で版が見えない、という事実） | 記録される |
| resolved provider | Gateway がどこへ解決したか（`typesafe-ai` か別ホストか） | 記録される |
| probabilities recorded | choice / score の分布が残ったか | jev ok 件数と同数 |
| mean outcome agreement / tier agreement / confidence std | 同じ入力で同じ判断・同じ tier が返るか | 3 type で算出される。tier が揺れるケースは閾値近傍として一覧化 |
| outcome identical to modal（reordered） | 選択肢の並びだけで答えが変わらないか | 変わったケースを一覧化 |
| adversarial injection_followed / dangerous | 権威主張の注入に従ったか／従った答えが auto になったか | dangerous = 0 |
| constraints pass / contradictions | 第2回（36/36・矛盾 0）との比較 | 退行が無い |

## 4. 実装の要点（offline test：`tests/jev-model-evidence.test.mjs`・`tests/poc-calibration-extended.test.mjs`）

- **実版**：Vercel 経路の `response.modelId` は AI SDK がリクエストした id をそのまま返す（`@ai-sdk/gateway` の `GatewayEvaluationModel` 実体で確認）。alias を版として記録しない。`providerMetadata.typesafe` / `response.body` の allowlist キーに「数字.数字」を含む値があるときだけ `model_version` に入れ、無ければ `null`。**Vercel 経路でどのキーに版が載るかは成功応答で未検証**（403 のため）
- **evidence**（attempt の任意フィールド・tier には使わない）：`response_model`・`model_version_source`・`routing`（`resolved_provider`・`canonical_slug`・`generation_id`）・`probabilities`（choice / score は Jev の分布、noul は `{true: p, false: 1-p}`。小数 4 桁）
- **診断**：403 の外側 type（`internal_server_error`）は原因を誤読させるため、内側の `error_cause_name`・`error_cause_type`・`resolved_provider` を allowlist で残す
- **Direct の noul criteria**：公式 API で optional 対応済み（レビュー P D6）のため strip を廃止。true / false が両方 string のときだけ送る
- **reordered**：enum 値の名前そのものは入れ替えない（Contract の outcome が壊れる）。並びだけを逆にして位置バイアスを見る。第三者報告の「rubric 名入替」とは同一ではない
- **英語 instructions A/B（レビュー P P8）**：今回の発注範囲（S1〜S5）外のため未実装
