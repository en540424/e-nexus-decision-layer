# Cursor から使う

Cursor の Agent / Rules から同じ CLI を呼ぶ。本体は変更不要。

- `.cursor/rules` に「有料生成・外部API・Human 確認が絡む判断は `node <repo>/src/cli.mjs decide` を先に呼ぶ」と書く
- 結果 JSON の `tier` と `human_gate.required` を見て、`human` なら作業を止めて Human へ渡す
- Cursor 側にも Jev API Key は置かない（Decision Layer の `.env` のみ。既定でネットワーク無効）

将来：Cursor 専用の薄い wrapper（`integrations/cursor/decide.mjs`）を置く場合も core は触らない。
