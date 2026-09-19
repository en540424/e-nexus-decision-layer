# PoC: 有料生成API直前の Decision Gate（`paid-generation-gate`）

## 選定理由（2026-09-19）

候補は3つあった：①有料生成直前のDecision Gate ②Model Router ③Skill Router。①を採用。

| 観点 | ① 有料生成Gate | ② Model Router | ③ Skill Router |
|---|---|---|---|
| リスク | 低。en-generate-hub の**手前**で動き、承認・予算・台帳に触れない | 中。Claude Code の Model 選定は settings.json（Human-only）と結び付き、実接続には権限変更が要る | 中。Claude Code の Skill 起動は本体の暗黙判断で、差し込み口が無い |
| 効果測定 | 容易。「有料が要らなかった件数」「Human review に上がった件数」を usage.jsonl で数えられる | 難。既存の rules 表（Advisor§2-2）が既に決定的で、Jev の出番が少ない | 難。正解ラベルが無い |
| 既存構造との一致 | MA-29 OpenMontage ログ §12–13 が「支払い前ゲート」を接続候補として既に記録 | AI-Company §6 の表が既に rules。Jev 不要 | Skill台帳が人間向けで機械可読でない |

②は **rules だけで完結する**ことが監査で分かったため、Jev PoC には向かない（代わりに `policies/routing/rules/model-route.json` として rules 化し、Sonnet First / Advisor 13条件 / Fable 特別承認制を機械可読にした）。

## 入出力

```
input : asset_kind, purpose, style?, duration_sec?, has_reference_media?, has_local_assets?, estimated_paid_cost_usd_micros?, language?
outcome: local_sufficient, remotion_suitable, paid_generation_required, human_review_required, recommended_route(local|remotion|en-generate-hub|human-review)
```

`paid_generation_required=true` は「en-generate-hub の Human-only 承認フローへ持ち込む価値がある」という意味でしかなく、**実行許可ではない**。

## 判定順

1. rules：字幕・kinetic typography・slideshow → Remotion（MA-29 で Human 確認済み）／素材あり＋flat → local／推定 $5 以上 → 必ず human
2. mock-jev：photoreal / cinematic / 参照素材あり → 有料候補 + human review（confidence 0.75–0.88）／曖昧 → 0.55 → human
3. human：escalation

## 測定するもの（usage.jsonl）

- `resolved_by` の分布（rules で何割解けたか＝Jev を呼ばずに済んだ割合）
- `tier` の分布（auto / review / human）
- `fallback_occurred`・`human_escalation` の比率
- 閾値調整はこの実測を根拠に行う

## 実接続確認（Vercel経路、2026-09-19）

`request-vercel-test.json`（repo直下）が実疎通用の入力例。photoreal シーン + `paid-generation-gate`。

```
node src/cli.mjs decide --file request-vercel-test.json
```

`JEV_PROVIDER=vercel`・`AI_GATEWAY_API_KEY`・`EDL_ALLOW_NETWORK=true` をシェルへ export した状態で実行し、Human が成功を確認した（`.env` はCLI から読まれないため、実行前にシェルへ export する。§`.env.example`）。結果：`rules:unavailable(NO_RULE_MATCHED) → jev:ok(confidence≈0.08, tier=human, latency 881ms) → local:unavailable(LOCAL_MODEL_NOT_CONFIGURED) → human:ok`。`resolved_by: human`。`mock-jev` は `NOT_REGISTERED`（`src/index.mjs` の `realJevUsable()` により実 Jev 経路使用時は chain に登録されないことを実測確認。詳細は `docs/decision-log.md`）。

## 接続（未実装・Human 判断待ち）

OpenMontage の `video_generation` カテゴリ（27ツール）が「支払い前にツール名・Provider・モデル・理由を宣言してターンを終える」設計なので、
その宣言を `decide` へ渡し、`recommended_route=en-generate-hub` のときだけ `/en-generate` Skill（見積・承認提示）へ進む、が自然な接続点。
OpenMontage 本体・en-generate-hub 本体は変更しない（wrapper / integration 側で接続）。
