# VPS の保守を 1 回にまとめる手順（Human・2026-11-10）

**全部 Human が行う**（AI は SSH しない・Cloudflare を変えない・鍵を見ない）。2 つの作業を 1 回の ssh にまとめる。どちらも独立した判断なので、片方だけでもよい。

| # | 作業 | 判断 | 既存への影響 |
|---|---|---|---|
| A | 生存信号の受け側（heartbeat）の修正を入れる（未送信の途絶が復旧で上書きされる問題） | 承認済みの H6 の保守（新しい公開経路なし） | `e-nexus-heartbeat` の再起動の数秒だけ受信しない |
| B | Task Hub の受け口（task intake）を入れる | **新しい公開の入口**（Cloudflare の hostname 1 つ）＝Human の新しい承認 | 新しい user・unit だけ。既存の service・cloudflared の設定・firewall は変えない |

既存の n8n・Cloudflare Tunnel・電話 AI の Webhook・heartbeat の設定は変えない（install.sh が既存の service の PID を前後で比べ、変われば NG と言う）。

## 0. 前に（Mac・Windows の clone で）

- repo が最新か：`git log -1`（この文書がある版）
- Mac の試験：`npm test`（Claude Code が実施済みの件数は開発ログを参照）

## A. heartbeat の更新（5 分）

```
scp deploy/vps-heartbeat/receiver.mjs <VPS>:vps-heartbeat/receiver.new.mjs
ssh -t <VPS>
# ── ここから VPS ──
sudo cp -p /opt/e-nexus-heartbeat/receiver.mjs ~/vps-heartbeat/receiver.prev.mjs        # 戻す時のため
sudo cp -p /var/lib/e-nexus-heartbeat/state.json ~/vps-heartbeat/state.prev.json 2>/dev/null || true
diff <(sudo cat /opt/e-nexus-heartbeat/receiver.mjs) ~/vps-heartbeat/receiver.new.mjs | head -5   # 差があることだけ見る
sudo install -m 0644 ~/vps-heartbeat/receiver.new.mjs /opt/e-nexus-heartbeat/receiver.mjs
sudo systemctl restart e-nexus-heartbeat && sleep 2 && systemctl is-active e-nexus-heartbeat
sudo journalctl -u e-nexus-heartbeat -n 5 --no-pager                                    # "listening" が出る
```

- **確認**：Mac の次の :20 か :50 の後に `sudo journalctl -u e-nexus-heartbeat -n 3` にエラーが無い。Mac で `node scripts/runtime-ops.mjs overview` の「生存信号：sent」
- **state の互換**（2026-11-10 に Claude Code が旧版（`9528860` の前）と新版の receiver を loopback で動かして一度確かめた。repo の試験には入っていない）：旧版が残した未送信の途絶は新版が送る。戻した時は新版の `down_up`／`repeat_up` を旧版が読まずに捨てる（未送信の 1 通を失うだけ・落ちない）
- **戻す**：`sudo install -m 0644 ~/vps-heartbeat/receiver.prev.mjs /opt/e-nexus-heartbeat/receiver.mjs && sudo systemctl restart e-nexus-heartbeat`

## B. task intake の導入（20〜30 分・承認した時だけ）

手順の詳細は `deploy/vps-task-intake/README.md`。同じ ssh の中で：

1. `install.sh`（channel の鍵が画面に 1 回だけ出る → Mac の Keychain へ入れるまで画面を閉じない）
2. `install.sh add-source <bot id> '<intents>'`（**最初は受付の Bot 1 つだけ**を推奨。intents は `status.query,report.morning,mail.digest.ingest,calendar.digest.ingest,note.record`。鍵は画面に 1 回だけ）
3. VPS の中の確認：`curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8796/mcp` が 401、`curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8796/` が 404

### Cloudflare（Human・ダッシュボード）

設定の材料（そのまま貼れる式・任意の rate limit・Tunnel の 1 行・検収の script・NG の時・戻し方）は `deploy/cloudflare-task-intake/README.md`。

- Zero Trust → Networks → Tunnels → 既存の Tunnel → Public Hostname → **Add**（既存の行は触らない）。hostname は既存と別の名前、Service `http://127.0.0.1:8796`
- Security → WAF → Custom rules → **Create**（この hostname だけに効く式。既存のルールは変えない）：
  ```
  (http.host eq "<足した hostname>") and not (
    (http.request.method eq "POST" and http.request.uri.path in {"/mcp" "/ack" "/status"}) or
    (http.request.method eq "GET" and http.request.uri.path in {"/pull" "/mcp"})
  )
  ```
  Action：Block。`GET /mcp` は通して受け口の 405 を返させる（MCP の client は 405 を「SSE なし」と読む。Cloudflare の 403 だと失敗と読む client がある）。Grok Bot の送信元の IP は公開されていない（xAI の docs：remote MCP へは Bot の基盤側の server から繋ぐ・範囲は公開されず account team に問い合わせ）ので **IP の allowlist は使えない**。Bearer と path・method で絞る
- 任意：Rate limiting rule（同じ hostname・`/mcp`）。無料の plan では数える期間が 10 秒に限られる（plan の画面で確かめる）ので、例えば「10 秒に 20 回で Block」。受け口の中にも bot ごとの上限がある（submit 60 件／時・呼び出し 600 回／時）

### Mac（Human・Terminal）

```
bash deploy/macos/keychain-edl.sh set task-intake-vps-intake   # 手順 1 の channel の鍵（マスク入力）
bash deploy/macos/keychain-edl.sh set task-intake-url          # https://<足した hostname>
```

### Grok Bot（Human・Bot の画面）

- Bot の Computer & Apps → MCP の追加 → **Remote HTTPS**、Server URL `https://<足した hostname>/mcp`、**HTTP headers** に `Authorization: Bearer <手順 2 の鍵>`（xAI の docs に「optional HTTP headers」があることは確認。Bearer の形がそのまま通るかは未確認＝下の検収 2 で確かめる）
- Bot の Ask first に「この MCP の submit_task」を足す（Bot が勝手に依頼を出さないように。任意）

## 検収（Human の操作の後に Claude Code が行う）

1. Mac：`node scripts/task-intake-sync.mjs pull --inbox <inbox>` が `not_configured` でなく `pulled`（0 件でよい）・exit 0
2. Bot で `list_capabilities` → `submit_task`（`status.query`）→ Mac で pull → `task-hub intake` → `run` → `push` → Bot の `get_task_status` が `succeeded`。**ここで初めて「接続済み」と書く**
3. `node scripts/task-intake-edge-check.mjs --url https://<足した hostname>` が合格（別の鍵・鍵なしの `POST /mcp` が 401、許可していない path・method が Cloudflare の 403。読むだけ）
4. heartbeat：overview の「生存信号：sent」と VPS の journal にエラーが無い

## 失敗した時

| 症状 | 戻し方 |
|---|---|
| install.sh が NG（既存の service の PID が変わった等） | install.sh は既存を変えないが、NG の内容を写して止める。`deploy/vps-task-intake/README.md`「戻し方」 |
| Bot が繋がらない（header を送れない・SSE が要る） | Cloudflare の hostname を消す（入口が消える）。Bot の MCP の設定を外す。設計の見直しは Claude Code が行う |
| heartbeat の更新の後に受信しない | A の「戻す」 |
