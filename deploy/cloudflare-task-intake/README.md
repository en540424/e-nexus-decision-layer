# Task Hub の受け口の入口（Cloudflare）— 設定案と検収（2026-11-10・Human が導入）

**AI は Cloudflare を変えない。** 新しい公開の入口（hostname 1 つ）は Human の新しい承認（`docs/vps-maintenance.md` B）。この folder は承認の後に最小の操作で入れるための材料。

| file | 何 |
|---|---|
| `tunnel-public-hostname.example.yml` | 既存の Tunnel に足す 1 行（hostname → `http://127.0.0.1:8796`）。既存の行は変えない |
| `waf-custom-rule.json` | WAF の custom rule：受け口の 5 つの経路（POST `/mcp` `/ack` `/status`・GET `/pull` `/mcp`）以外を Block。この hostname だけ |
| `rate-limit-rule.json` | 任意。`/mcp` を 10 秒に 20 回で Block（Free の plan は rule 1 つ・期間 10 秒だけ＝Cloudflare の docs の rate limiting rules の表） |

## 守ること（既存との分離）

- hostname は既存（n8n・電話 AI の Webhook・heartbeat）と**別の名前**。既存の Public Hostname・ingress の行・WAF の rule は触らない
- WAF の式は `http.host eq "<HOSTNAME>"` で始まる＝他の hostname に効かない
- 認証は受け口の Bearer（bot ごとの鍵）と、Mac の pull・ack・status の HMAC 署名。Cloudflare Access は使わない（Grok Bot の基盤から来る request は Access の login を通れない。送信元の IP も公開されていない＝IP の allowlist は不可）
- `GET /mcp` は WAF で通して受け口の 405 を返させる（MCP の Streamable HTTP では「SSE の stream なし」の意味。Cloudflare の 403 だと失敗と読む client がある）。xAI の Remote MCP の docs は「Streaming HTTP と SSE」の 2 つを受け、Authorization の header を付けられる（2026-11-10 に確認）。Grok Bot の画面で Bearer がそのまま送られるかは検収 2 で確かめる

## 入れる順（Human）

1. VPS に受け口を入れる（`deploy/vps-task-intake/README.md`）。VPS の中で `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8796/mcp` が 401
2. Tunnel に hostname を足す（上の yml の 1 行・または Public Hostname の画面）
3. WAF の custom rule を作る（`waf-custom-rule.json` の `<HOSTNAME>` を置き換えて、画面の Expression Editor に貼る。Action は Block）
4. 任意：rate limiting rule（`rate-limit-rule.json`）
5. Mac で検収（下）

## 検収（Mac・Human か Claude Code。読むだけ・依頼を置かない）

```
node scripts/task-intake-edge-check.mjs --url https://<HOSTNAME>
```

8 項目：鍵なし・違う鍵の `POST /mcp` が 401／`GET /mcp` が 405／`GET /`・`PUT /mcp`・`POST /pull`・`GET /.env` が Cloudflare の 403／署名なしの `GET /pull` が 404。
Bot の鍵を Keychain に入れた時だけ `--bearer-credential credential:E-NEXUS/edl/<name>` で initialize・tools/list・list_capabilities（読むだけ）も確かめる。
rate limit は数えない（本番に連打しない）。確かめる時は Human が画面の「Security → Events」で rule の発火を見る。

### NG の時

| NG | 原因の見当 |
|---|---|
| `root_blocked` などが 404 | WAF の rule が無い・hostname の綴りが違う（受け口の 404 が見えている） |
| `mcp_no_auth` が 403 | WAF が `/mcp` も止めている（式の method・path の綴り） |
| どれも `network`／530 | Tunnel の hostname が無い・cloudflared が受け口へ届かない |
| `mcp_get_no_sse` が 403 | `GET /mcp` を通していない（式の 2 つ目の括弧） |

## 戻す

WAF の rule → rate limiting rule → Tunnel の hostname の順に消す（hostname を消せば入口は無くなる）。受け口は `deploy/vps-task-intake/README.md`「戻し方」。既存の hostname・rule は最初から触っていないので戻す物は無い。
