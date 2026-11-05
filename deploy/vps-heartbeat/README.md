# Mac mini の外部死活監視（VPS の受け側）

2026-11-05 作成（H6・Human 承認）。Mac の上の監視は Mac の停止を知らせられないので、外の VPS で「生存信号の途絶」を見る。**VPS への導入は全部 Human**（AI は SSH しない）。新しい契約・課金なし。

```
Mac mini（host-health・30 分ごと）──HTTPS POST /hb（HMAC）──▶ Cloudflare Tunnel（既存）──▶ 127.0.0.1:8795 receiver ──途絶・復旧だけ──▶ Discord
```

| 項目 | 内容 |
|---|---|
| 送るもの | 時刻と署名だけ（ホストの情報・状態・本文なし） |
| 異常 | 最後の信号から 70 分途絶えたら 1 回（60 分以上の途絶。信号は 30 分ごとなので、1 回の抜けでは鳴らない）。原因は断定しない |
| 復旧 | 戻ったら 1 回（反復の後は落ち着いてから 1 回） |
| 正常時 | 通知なし |
| 乱発の防止 | 24 時間に 2 回途絶えたら「反復」を 1 通で、24 時間は静か。静かな間に始まった途絶も明けた時に続いていれば知らせる |
| 既存への影響 | 新しい user・unit だけ。memory 128 MB・CPU 10%・同時接続 32 の上限。既存の service・Docker・Serve／Funnel・firewall は変えない |

Mac は Tailscale に未参加なので、経路は既存の Cloudflare Tunnel の Public Hostname を 1 つ足す形にする。Tunnel は Dashboard 管理（token 方式）で、VPS の設定ファイルと cloudflared の再起動は要らない。

## 導入（Human）

1. Discord の監視チャンネルで、この受け側専用の Webhook を作る
2. Windows の clone から VPS へ写して実行する：
   ```
   scp -r deploy/vps-heartbeat <VPS>:vps-heartbeat
   ssh -t <VPS> sudo bash vps-heartbeat/install.sh
   ```
   URL の入力を求められる（`-t` が無いと止まる）。チャンネルに配送試験が 1 通届く。最後に出る token を控える（画面にだけ出る）。既存の service の PID を前後で比べ、変われば NG と言う。port は既定 8795（`HEARTBEAT_PORT` で変えられる）
3. Cloudflare の Zero Trust → Networks → Tunnels → 既存の Tunnel → Public Hostname を**足す**（既存の行は変えない）。Service は `http://127.0.0.1:8795`。既存の hostname とは別の名前にする。同じ Tunnel を電話 AI が使うので、Security → WAF のカスタムルールで、この hostname は `POST /hb` だけ通すルールを足す（無料の枠の範囲）
4. Mac の Terminal で `bash deploy/macos/connect-heartbeat.sh`。URL（`https://<足した hostname>/hb`）と token を Keychain へ入れ、試しに 1 回送る。204 なら完了。job は登録済みで、次の :20／:50 から送る

## 確認

- `systemctl status e-nexus-heartbeat`（loopback の待受・`MemoryMax`）
- 途絶の試験：Mac の Keychain から `heartbeat-url` を消すと 70 分ほどで Discord へ届き、戻すと復旧が届く
- `journalctl -u e-nexus-heartbeat`：`delivery_failed`（Discord へ送れない）・`state_unwritable` はコードだけ出る

## 戻し方

```
sudo systemctl disable --now e-nexus-heartbeat
sudo rm -f /etc/systemd/system/e-nexus-heartbeat.service /etc/e-nexus/heartbeat.env && sudo systemctl daemon-reload
sudo rm -rf /opt/e-nexus-heartbeat /var/lib/e-nexus-heartbeat && sudo userdel edl-heartbeat
```

Cloudflare の Public Hostname を消し、Mac の `keychain-edl.sh delete heartbeat-url`・`heartbeat-token`。Mac は credential が無ければ何も送らない。

## 限界

- VPS 自身・Cloudflare・Discord が止まると知らせられない
- 一度も受信していない間は知らせない（導入の途中で鳴らさない）
- 計画した Mac の停止でも 70 分で鳴る（止める時は Human が承知しておく）
- host-health が `DISABLED` の時は信号を送らないので途絶として届く（監視の停止の検知を兼ねる）
