# VPS staging（E-NEXUS Common Decision Gateway）

2026-09-30 作成（Deployment Completion Phase・Human 承認）。既存の E-NEXUS VPS に **staging だけ**を置く道具。
SSH を開始するのは Human（VPS 台帳§0-3）。Human の操作は **1 コマンド**：

```
node C:/Users/envie/e-nexus-decision-layer/deploy/vps-staging/run.mjs --tailscale-name <VPS の Tailscale 名>
```

## 構成（Human 決定 2026-09-30・方式 B）

```
Mac mini / Hermes / PC ──Tailnet HTTPS──▶ Tailscale Serve https:<serve port>（Tailnet 限定・Funnel なし）
                                              │
                                              ▼
                     127.0.0.1:<gateway port>  e-nexus-decision-gateway-staging（systemd・User=edl-staging・MemoryMax=256M）
                                              │  EDL_ENVIRONMENT=staging・pinned release・token 必須
                                              ▼
                     rules → （Jev は切ってある＝EDL_ALLOW_NETWORK 無し）→ human
```

- consumer-kit の https 必須ルールは変えていない（loopback の http を staging で許す案 A は不採用）。
- Jev（TypeSafe Direct）へつなぐのは Human GO の後：staging 用 Jev key の投入と `EDL_ALLOW_NETWORK=true` は Human。
  それまで stage.sh は env file にこれらがあると止まる（有料 0 の保証）。

## 1 回の実行でやること（run.mjs → stage.sh）

| 順 | 段 | 中身 |
|---|---|---|
| 1 | ローカル | git が clean（tracked）・`npm test` 相当・release A＝HEAD~1／B＝HEAD の確認 |
| 2 | 転送 | git bundle（VPS に GitHub 資格情報を置かない）と kit（audit.sh・stage.sh・vps-tool.mjs）を ssh の標準入力で |
| 3 | audit | read-only 監査（report にだけ残す） |
| 4 | preflight | root・node≥20（/root・/home 以外）・tailscale≥1.52・空きメモリ 300MB・disk 2GB・負荷・既存 service が active・port 選定（既存 22/80/443/4188/5678/5679/8443/8444/8787/18789 を避ける）・有料鍵が無いこと。**落ちたら何も変えない** |
| 5 | deploy 演習 | install A → smoke → install B → smoke → rollback（`gateway-release.mjs previous`）→ smoke A → install B → smoke |
| 6 | failure | 設定誤り（release 不一致 → exit 2・再起動しない）・SIGKILL → 自動復帰・同じ port の 2 つ目 → 即失敗・graceful restart・enabled |
| 7 | E2E | PC から HTTPS：MA-17・CRM の形の判定 6 件・token 違い・環境違い・400・415・http で応答しない・Python transport（Hermes 経路・WARN 扱い） |
| 8 | digest | `e-nexus-usage-digest-staging.timer`（毎日 06:05・report モード）を入れて 1 回実行 |
| 9 | postflight | 既存 service（Product Hub・audio-processor・cloudflared・tailscaled・docker・backup timer・n8n container）の状態・PID・起動時刻が不変／他の Serve 設定が不変／新しい待受 port は staging の 1 つだけで 127.0.0.1／usage に有料・networked 0／env file 0640／token がログに無い |
| 10 | token | staging token を PC の Windows 資格情報マネージャー `E-NEXUS/edl/gateway-token-staging` へ（値は出さない） |

コンソールには FAIL・WARN・RESULT・要約だけ。全文は `%TEMP%\e-nexus-staging-report-<時刻>.txt`（Secret なし・VPS の名前はここにだけ）。
何度流しても同じ結果になる（冪等）：port・token・env file は再利用、unit は変わった時だけ入れ替え、backup は `/var/lib/e-nexus-staging/backups/`。

## 変えるもの・変えないもの

- 変える（staging だけ）：user `edl-staging`・`/opt/e-nexus-staging`・`/etc/e-nexus/gateway-staging.env`・`/var/lib/e-nexus-staging`・
  unit `e-nexus-*-staging*`・Tailscale Serve の https port 1 つ。
- 変えない：既存 service の停止・再起動・設定、他の Serve／Funnel、firewall、package の更新、reboot、Production。
  状態を変える `systemctl` は staging 名以外を拒否する wrapper（`sctl`）だけから呼ぶ（tests/vps-staging-kit.test.mjs が固定）。

## 撤去（任意・Human）

`bash /root/e-nexus-staging-inbox/kit/stage.sh uninstall --yes`：unit と Serve の port を外す（repo・env file・data・backup は残す）。

## 既知の挙動

- Node 24（2026-09-30 に確認）は **script の後ろの `--env-file <path>` も存在確認する**（中身は読み込まない）。
  path が無いと script より前に exit 9 で止まる。gateway の env file が消えた場合は exit 9＝`RestartPreventExitStatus=2` の外なので、
  `StartLimitBurst`（300 秒に 5 回）で止まる。vps-tool.mjs の引数名が `--env-path` なのはこのため。

## Mac mini（Hermes 等）から使う（2026-09-30 準備・実機は後日＝DEVICE_DEPENDENT）

経路：Mac mini／Hermes → Tailnet HTTPS → staging Gateway（→ Jev は Human GO の後）。

1. Mac で（Human・SSH を開始するのは Human）：`bash deploy/vps-staging/mac-fetch-token.sh --tailscale-name <VPS>`
   - VPS から staging token を取り、login Keychain の `E-NEXUS/edl/gateway-token-staging`（account `e-nexus`）へ入れる（値は表示しない・`security -i` の標準入力）。
   - 表示するのは stored／failed と staging URL（`https://<vps>.<tailnet>.ts.net:<serve port>`）だけ。
2. consumer（Hermes は `consumer-kit/python/enexus_http_transport.py`）は `HttpTransport(<staging URL>, <Keychain の token>, "staging")`。
   https 必須のまま（Tailscale Serve が TLS 終端）。`gateway.environment` が staging でないと `ENVIRONMENT_MISMATCH`（fail-closed）。
3. Windows の PC では run.mjs が同じ名前で資格情報マネージャーへ入れてある（`credential:E-NEXUS/edl/gateway-token-staging`）。

VPS の root へ Mac から SSH できること（鍵の登録か password）は Human の準備。token を回す（rotation）ときは VPS の env file の
`EDL_GATEWAY_TOKEN` を変えて run.mjs を流し直し、PC（自動）と Mac（このスクリプト）を入れ直す。
