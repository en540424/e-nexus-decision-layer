# Claude Code から使う

Claude Code は **Hook や settings.json を変えずに**、通常の Bash 実行として CLI を呼ぶ。
（`.claude/settings.json` の変更は Human-only。将来 Hook 化する場合も Human が配線する）

```bash
node C:/Users/envie/e-nexus-decision-layer/src/cli.mjs decide --json '{
  "decision_type": "paid-generation-gate",
  "application_id": "claude-code",
  "project_id": "openmontage",
  "input": { "asset_kind": "scene", "purpose": "商品ヒーロー", "style": "photoreal" }
}'
```

- `tier=auto` → 呼び出し側が通常コード／Remotion／local へ進んでよい候補（既存ゲートは別途通る）
- `tier=review` → 上位LLM再判定（llm adapter 実装まで）は Claude Code 本体が Advisor 相談または Human 確認へ倒す
- `tier=human` / `recommended_route=en-generate-hub` → `/en-generate` Skill（見積・承認提示）へ。承認文は Human が入力する

Model / Skill Router（`model-route` / `skill-route`）は schema と rules を用意済み。Claude Code 本体の Model 選定は
引き続き Advisor 正本と settings.json が正本であり、Decision Layer の結果は**参考値**（設定を変えない）。
