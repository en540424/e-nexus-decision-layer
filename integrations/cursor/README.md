# Cursor から使う

**2026-09-25〜：Common Decision Gateway（`docs/gateway.md`）を使う。** MCP 対応なので `~/.cursor/mcp.json` に
`node <repo>/src/cli.mjs gateway mcp` を stdio server として登録すれば `enexus_decide` が使える（登録は Human-only・Vault MCP接続台帳）。
CLI なら `gateway decide --stdin`。以下は従来の記述。

Cursor の Agent / Rules から同じ CLI を呼ぶ。本体は変更不要。

- `.cursor/rules` に「有料生成・外部API・Human 確認が絡む判断は `node <repo>/src/cli.mjs decide` を先に呼ぶ」と書く
- 結果 JSON の `tier` と `human_gate.required` を見て、`human` なら作業を止めて Human へ渡す
- Cursor 側にも Jev API Key は置かない（Jev の鍵は User 環境変数 `JEV_API_KEY` だけで、Gateway の engine-env manifest が子 process へ必要な名前だけを渡す。CLI は `.env` を読まない＝`docs/gateway.md` §11-1。`EDL_ALLOW_NETWORK=true` が無い process ではネットワーク無効）

~~将来：Cursor 専用の薄い wrapper（`integrations/cursor/decide.mjs`）を置く場合も core は触らない。~~ → 2026-09-29 FB-23 で不採用（rule から `gateway decide --stdin` を直接使う。decision-log 2026-09-29）

## rule の雛形（2026-09-29・FB-23）

`integrations/cursor/enexus-decision.mdc`（Cursor の Project Rule 形式：frontmatter `description`・`alwaysApply: false`＝Agent が description を見て適用を決める。形式は Cursor docs で確認）。使う repo の `.cursor/rules/` へ写し、`<repo>` を `e-nexus-decision-layer` の場所に置き換える。内容は Claude Code の `enexus-decision` Skill と同じ契約（`application_id: "cursor"`・`expected_environment: "dev"`・stdin・fail-closed・判定は承認ではない）。Cursor の User Rules・MCP への登録は Human が行う。

**2026-09-29 配置済み**：`e-nexus-decision-layer`（`node src/cli.mjs`）・`en-sns-hub`・`en-generate-hub`（`node ../e-nexus-decision-layer/src/cli.mjs`）の `.cursor/rules/enexus-decision.mdc`。repo を兄弟フォルダに並べる配置（Windows・Mac mini の `deploy/macos/bootstrap.sh` 共通）を前提にした相対パスなので、PC ごとの書き換えは要らない。雛形を直したら 3 か所へ写し直す。rule の表の 4 type を使わない repo（crm-core 等）には置いていない。

