# OpenMontage から使う（2026-09-26・MA-29 × MA-30）

OpenMontage（`C:\Users\envie\poc\openmontage-ma29`、MA-29 技術PoC成功・条件付き採用候補）の **有料生成の直前**で、
Common Decision Gateway の `paid-generation-gate` を呼ぶ thin consumer adapter。`application_id: openmontage`・PERSONAL / DEV のみ。

```
OpenMontage workflow（agent が有料 tool＝video_generation / image_generation 等の API tool を選びそうになった時点）
  → enexus_openmontage_decision.py（request を組む・Gateway を呼ぶ・typed result を返す）
  → Common Decision Gateway（local CLI `gateway decide --stdin`・environment=dev）→ Rules → Decision Engine → Human
  → route=local / remotion        ：OpenMontage の無料経路（手元素材・Remotion）で作る候補
    route=en-generate-hub         ：/en-generate（MA-17：見積 → Human-only 承認 → run-approved）へ引き継ぐ候補
    route=human-review / 取得失敗 ：Human が判断
```

## 置き場所の理由

- consumer adapter は本来 consumer 側に置くが、`poc/openmontage-ma29` は上流 `calesthio/OpenMontage`（AGPL-3.0）の clone で、
  push 先が無く、正式基盤登録・`managed-repos.json` 登録は Human-only（MA-29）。そのため Gateway repo の `integrations/`
  （claude-code / cursor / hermes と同列）に置く
- **OpenMontage のコードを import しない**（process 境界の外で動く独立 adapter。AGPL の範囲を E-NEXUS 側へ広げない。
  入力は caller が渡す構造情報だけ）。OpenMontage の tracked files（`AGENT_GUIDE.md` 等）も編集しない
- stdlib のみ（Python 3.10+）。Gateway 呼び出しには `node` が要る

## 使い方

```bash
python C:/Users/envie/e-nexus-decision-layer/integrations/openmontage/enexus_openmontage_decision.py --text < asset-request.json
```

asset request（OpenMontage workflow が組む構造情報。`tool.estimate_cost()` / `dry_run()` の値を使ってよい）：

```json
{
  "capability": "video_generation",
  "purpose": "製品紹介の導入カット（5秒・動きのある実写風）",
  "style": "photoreal",
  "duration_sec": 5,
  "has_reference_media": false,
  "has_local_assets": false,
  "estimated_cost_usd": 0.35,
  "language": "ja",
  "tool": "kling_video", "provider": "fal", "pipeline_stage": "assets"
}
```

- Decision Engine へ送るのは `input`（asset_kind・purpose・style・duration・参照/手元素材の有無・見積 micros・language）だけ。
  `tool` / `provider` / `model` / `pipeline_stage` は `context`（Engine へ送られない）
- `purpose` は 200 字で切り、ローカルパスを伏せ、メール・電話番号・key 風の文字列があれば 1 文字も送らない。
  **人物名・顧客名・prompt 全文は caller が入れない**（adapter は人物名を検出できない）
- 出力の `route` / `next_step` / `tier` / `human_check` / `confidence` / `external_engine_reached` / `request_id` / `environment` を読む。
  `proceed_automatically` は常に `false`、`openmontage_builtin_paid_tools` は常に `forbidden`

## 守ること

- **どの結果（tier=auto・route=en-generate-hub を含む）も承認ではない。** 有料生成は /en-generate の MA-17 Human-only 承認だけが許可する
- OpenMontage 内蔵の有料 tool（fal / kling / runway / veo 等の API tool）を直接実行しない（MA-29 Human判断 2026-09-17）
- local CLI transport は `dev` のみ。一般販売・外部ユーザー向けの経路にしない（`docs/gateway.md` §12）

## テスト

```bash
cd C:/Users/envie/e-nexus-decision-layer/integrations/openmontage
python -m unittest discover -s . -p "test_*.py"
```

transport は `consumer-kit/conformance/transport-cases.json`（Node reference と同じ cases）を fake Gateway 相手に全件通す。
実 Decision Engine は呼ばない（実 Gateway 往復はネットワーク無し・usage は tmp）。
