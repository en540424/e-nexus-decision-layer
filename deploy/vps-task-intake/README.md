# Task Hub の VPS 受け口（MCP で依頼を預かる）

2026-11-09 作成（MA-24）。Grok Bot のようにクラウドで動く agent は、公式 API がなく、URL で指定した MCP サーバーだけを呼べる。Mac は inbound の口を持たない。
そこで VPS に「預かるだけ」の受け口を置き、Mac が outbound で取りに行く。**VPS への導入・Cloudflare の公開経路・Bot への登録は全部 Human**（AI は SSH しない・route を足さない）。新しい契約・課金なし。

```
Grok Bot ──MCP(HTTPS・Bearer)──▶ Cloudflare Tunnel ──▶ 127.0.0.1:8796 intake ──封をして queue──┐
                                                                                              │ Mac が outbound で GET /pull（HMAC）
Grok Bot ◀─get_task_status─ 板（結果）◀── POST /status（Mac が署名）◀── Mac（検証・承認・処理）◀─┘
```

| 項目 | 内容 |
|---|---|
| 公開される口 | `POST /mcp` だけ（Bearer 必須）。`/pull`・`/ack`・`/status` は channel の鍵の HMAC が合う時だけ。他は全部 404 |
| MCP の tool | `submit_task`（依頼は提案）・`get_task_status`（自分の依頼だけ）・`list_capabilities` |
| VPS が持つもの | 封をした依頼（最大 7 日）・結果の板（14 日）・最後に受け付けた Mac の時刻。bot 鍵は sha256 だけ |
| 上限 | 1 bot あたり submit 60 件／時・tool 呼び出し 600 回／時・queue 100 件／bot・500 件／全体 |
| 既存への影響 | 新しい user・unit だけ。memory 256 MB・CPU 20%・同時接続 64。既存の service・firewall は変えない |

## 脅威モデル

- **Bot 鍵は Bearer の秘密**。漏れるとその bot として依頼を置ける・その bot の結果を読める。VPS には sha256 しか置かない（`intake.mjs --add-source` が鍵を画面に 1 回だけ出す）。bot ごとに別の鍵にして、疑ったらその source を外す
- **Grok Bot の中身は信用しない**。params・summary は VPS が解釈も実行もしない。封の `source` は「どの鍵で認証できたか」から VPS が決める（引数で名乗っても無視）。Mac は封の署名と policy を通し、破壊的な操作は自動実行せず Human の承認を求める
- **channel の鍵**（VPS と Mac だけが持つ 32 byte 以上）が封・結果・Mac の要求の署名に使われる。VPS が破られるとこの鍵も読まれる（その場合は依頼の偽造ができる）ので、Mac は封の署名の後も policy と承認を最後の関門にする
- **VPS は何も実行しない**。Mac へ入ってくる口はない。VPS が止まると依頼も結果も届かないだけ
- 記録は journal にコードだけ（鍵・Bearer・本文・params・summary・送信元 IP は残さない）
- 限界：Grok Bot が Authorization header を付けられるかは未確認（下の「Bot 側の確認」）。Cloudflare の WAF で `POST /mcp` と Mac からの 3 つの path だけに絞るのを推奨

## 導入（Human）

1. clone から VPS へ写す（`wire.mjs` を一緒に）：
   ```
   COPYFILE_DISABLE=1 tar czf - deploy/vps-task-intake scripts/lib/task-hub/wire.mjs | ssh <VPS> 'mkdir -p task-intake-src && tar xzf - -C task-intake-src'
   ssh -t <VPS> sudo bash task-intake-src/deploy/vps-task-intake/install.sh
   ```
   最後に **channel の鍵**が画面に 1 回だけ出る。port は既定 8796（`TASK_INTAKE_PORT` で変えられる。8795 は heartbeat）。既存の service の PID を前後で比べ、変われば NG と言う
2. bot 鍵を作る（bot ごとに 1 回）：
   ```
   ssh -t <VPS> sudo bash task-intake-src/deploy/vps-task-intake/install.sh add-source bot-front 'report.*,note.add'
   ```
   `bot-front` は bot の id（小文字・数字・`-`）。最後の引数は許可する intent（省略＝全部。Mac 側の policy が最終の関門）。鍵は画面に 1 回だけ出る。service は再起動される（保存済みの依頼は残る）
3. Cloudflare の Zero Trust → Networks → Tunnels → 既存の Tunnel → Public Hostname を**足す**（既存の行は変えない。**新しい公開 route なので Human のみ**）。Service は `http://127.0.0.1:8796`。既存の hostname とは別の名前にする。Security → WAF のカスタムルールで、`POST /mcp`・`GET /pull`・`POST /ack`・`POST /status` 以外を止める（無料の枠の範囲）
4. **Grok Bot への登録（Human）**：各 Bot の MCP 設定に、URL `https://<足した hostname>/mcp` と、手順 2 の鍵を `Authorization: Bearer <鍵>`（または Bot の UI の「API key／Bearer」欄）として入れる。Bot ごとに別の鍵。鍵を会話や repo に貼らない
5. **Mac 側を有効にする（Human）**：`bash deploy/macos/keychain-edl.sh set task-intake-vps-intake`・`… set task-intake-url` で次の 2 つの item を入れる（値は手順 1 の鍵と手順 3 の URL。マスクされた入力）。無ければ Mac 側は何もしない（休眠）
   - `E-NEXUS/edl/task-intake-vps-intake` ＝ channel の鍵（64 hex）
   - `E-NEXUS/edl/task-intake-url` ＝ `https://<足した hostname>`（path なし）

   動かす道具は `scripts/task-intake-sync.mjs`（`pull --inbox <dir>`・`push --outbox <dir> --sent <dir>`）。定期実行の登録は Task Hub の導入手順（別 doc）で Human が行う

## 確認

- `systemctl status e-nexus-task-intake`（loopback の待受・`MemoryMax`）
- 認証なしの確認：`curl -i -X POST https://<hostname>/mcp` が 401（`WWW-Authenticate: Bearer`）、`curl -i https://<hostname>/` が 404
- Bot から：`list_capabilities` → `submit_task`（`idempotency_key` は 8 文字以上）→ Mac で `task-intake-sync.mjs pull` → 結果を `push` → Bot の `get_task_status` で `succeeded` 等が見える
- 別の bot の鍵で同じ `task_ref` を引いて `unknown` になること（source ごとに分かれる）
- `journalctl -u e-nexus-task-intake`：`queue_expired`・`state_unwritable`・`state_entries_dropped` などコードだけ

## 戻し方

```
sudo systemctl disable --now e-nexus-task-intake
sudo rm -f /etc/systemd/system/e-nexus-task-intake.service /etc/e-nexus/task-intake.env /etc/e-nexus/task-intake-sources.json && sudo systemctl daemon-reload
sudo rm -rf /opt/e-nexus-task-intake /var/lib/e-nexus-task-intake && sudo userdel edl-task-intake
```

- Cloudflare の Public Hostname を消す（これで公開の入口が消える）
- Grok Bot の MCP 設定から該当の URL・鍵を外す
- Mac の Keychain：`keychain-edl.sh delete task-intake-vps-intake`・`task-intake-url`（無ければ Mac は何もしない）
- 1 つの bot だけ止める：`install.sh remove-source <id>`（鍵の失効＝以後 401。その bot の取りに来ていない依頼と板の状態も再起動の時に捨てる＝漏れた鍵で積まれた依頼を Mac へ渡さない）。鍵を替える時は remove → add

## 費用

VPS の既存の契約の範囲（追加なし）。AI の呼び出しなし。メモリ上限 256 MB・保存は数 MB。

## Bot 側の確認（未検証の前提）

- Grok Bot が MCP の接続に `Authorization: Bearer` を付けられるか（独自 header／API key 欄の仕様は未確認）。付けられない場合は、Bot が付けられる形（独自 header 名・URL に鍵を含める等）に合わせる設計の見直しが要る（URL に鍵を含める形は log に残りやすいので推奨しない）
- Streamable HTTP の POST（JSON 応答）だけで動くか。この受け口は SSE（GET /mcp）を持たず 405 を返す。SSE 必須の client は繋がらない
- initialize の protocolVersion は `2025-11-25`・`2025-06-18`・`2025-03-26`・`2024-11-05` を受ける
- 結果の `result` はそのまま Bot に返る。Mac が書く内容に秘密を入れない

## 限界

- 取りに来る Mac が止まっている間、依頼は 7 日で捨てる（置き直せる）。結果の板は最後の push から 14 日
- rate の数えはメモリ上（service を再起動すると数え直し）
- Bot 鍵は sources ファイルの変更後に再起動して反映する（`install.sh add-source`／`remove-source` が行う）
