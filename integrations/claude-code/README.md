# Claude Code から使う

**2026-09-25〜：正式入口は Common Decision Gateway（`docs/gateway.md`）。** Claude Code は Vault の Skill `enexus-decision`
（`.claude/skills/enexus-decision/SKILL.md`）と Vault CLAUDE.md の発動ルールで、Decision Point（有料API・Local/Cloud・provider/model・
Human 確認要否・公開前・投稿先）に達したとき自動で `gateway decide --stdin` を呼ぶ。有料生成の前段は `/en-generate` Skill が
en-generate-hub `decision-gate` 経由で呼ぶ。Hook・settings.json は変えていない（Human-only）。MCP（`gateway mcp`）は実装済みで、接続は Human が行う：

```bash
claude mcp add --scope user enexus-decision -- node C:/Users/envie/e-nexus-decision-layer/src/cli.mjs gateway mcp
```

以下は従来の直接 CLI 呼び出し（後方互換。consumer は上の Gateway を使う）。

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
