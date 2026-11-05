# Mac Runtime の監視と連携の仕様

host-health を中心にした、決定的な監視（AI を呼ばない）の契約。正本は Vault の MA-22 ランブック §9-4・§11 と MA-24 で、ここは repo 側の実装の説明。
**この repo は公開なので、ホストの現在の状態・Trading Lab の詳細はここに書かない**（private の Vault へ）。

## 1. 構成

| 部品 | 役割 | 既定 |
|---|---|---|
| `scripts/host-health.mjs` | 30 分ごとの 1 回分：集める・判定する・記録する・変化を知らせる | 通信なし（`--webhook`・`--github-owner` を付けた時だけ） |
| `scripts/lib/runtime-guard.mjs` | Hermes の常駐と隔離・repo・relay・バックアップ・設定の改変 | host-health の中で動く |
| `scripts/lib/github-guard.mjs` | GitHub の公開範囲・CI・repo の異常 | token が Keychain にある時だけ（§4） |
| `scripts/lib/heartbeat.mjs`・`deploy/vps-heartbeat/` | 外部の死活監視（§3-1） | Keychain に入るまで何もしない・VPS の導入は Human |
| `scripts/lib/alert-policy.mjs` | 知らせる基準と本文の文（§2） | host-health の中で動く |
| `scripts/lib/quarterly-report.mjs` | 四半期の運用要約（§2-1） | host-health の中で動く |
| `scripts/host-health-watchdog.mjs` | host-health の停止を別の job から見る | 毎時 :35。監視専用で何も再起動しない |
| `scripts/lib/runtime-status-summary.mjs` | Hermes へ渡す要約（§6） | host-health の中で動く |
| `scripts/runtime-status-summary.mjs` | 要約を手で見る | 標準出力か一時フォルダだけ |
| `scripts/backup-*.mjs` | 暗号化バックアップ（§5） | 条件が揃うまで何も送らない・job の登録は Human |

監視は決定的なコードで回す。理由：常時の見回りに課金を載せない・判定を再現できる・Hermes の権限を増やさない。

## 2. 通知（Discord）

**普段は静かに監視し、本当に必要な時だけ Human に知らせる**（2026-11-05 Human 決定・E-NEXUS の標準方針）。基準は `scripts/lib/alert-policy.mjs`、判定は `host-health.mjs` の `decide`。
宛先は専用チャンネルの専用 Webhook。URL は Keychain の `E-NEXUS/edl/host-health-webhook` だけに置く（引数・ファイル・Git に置かない）。

| 種類 | Discord | 詳細 |
|---|---|---|
| 正常 | 送らない | 30 分ごとの記録だけ |
| 一時的な異常 | 送らない | WARN が 24 時間に満たない間は記録だけ。2 回続けて ok なら数え直す |
| 続く WARN | 1 回 | 24 時間続いた時に 1 回だけ。再通知なし・回復の通知なし |
| CRIT（重大） | すぐ 1 回 | 新規と WARN からの悪化 |
| CRIT の継続 | 控えめに再通知 | 24 時間後・その 48 時間後・96 時間後…（上限 7 日）。WARN へ下がった間は黙り、24 時間以上あいて CRIT へ戻れば知らせる。隔離・user 範囲は新しいコードが増えれば知らせ直す |
| 回復 | 1 回 | CRIT を知らせた項目だけ、2 回続けて ok になってから。送れない間に解消した CRIT も、送れるようになった回に 1 回（回線断は送信も失敗するので） |
| 行き来する CRIT | 間引く | 回復を知らせてから 6 時間は重ねない。続いていれば明けた回に知らせる（隔離・電源・回線・監視の停止は待たない） |
| 重大な出来事 | すぐ 1 回 | 再起動・監視の空白・Hermes の固定ファイルの変化・監視の定義と安全 policy の変化・常駐の増減・GitHub の公開範囲と既定 branch の変化 |
| 軽微な出来事 | 送らない | 回線の切替・Hermes の再起動。24 時間に 3 回繰り返した時だけ 1 回 |
| 重大の行き来（電源・回線・ディスク・メモリ・Hermes・隔離・監視の停止）と再起動・監視の空白の繰り返し | 「反復」を 1 通 | 1 回目はふつうに知らせる。24 時間に 2 回目で「反復」を 1 通送り、24 時間は静かにする。明けた時に重大が続けば再通知、落ち着けば回復を 1 回（回線断で送れないまま繰り返した時は、反復の 1 通で終わる）。**項目ごとに直近 24 時間で 3 通が上限**で、超える分は持ち越す。回線断で送れなかった回も数える。隔離の新しいコードだけは上限を待たない。原因は断定しない。上限は項目ごとで、同じ停電で電源と回線の両方が出ることはある |
| 監視の停止 | すぐ 1 回 | §3。`DISABLED` の間は 24 時間ごと。`monitor_alive`・`monitor_watchdog` は CRIT の継続と同じ間隔 |
| 運用要約 | 四半期に 1 通 | §2-1 |

項目ごとの例外：Hermes の停止は 1 時間（3 回の観測）続いたら重大として扱う（再通知と回復の通知あり）。user 範囲の指示の混入は WARN でも待たない。`repo:`・`relay_outbox` は WARN になるまでの猶予が 24 時間あるので、知らせるのは 48 時間後。`backup_time_machine` は 3 日で WARN なので 4 日後。

繰り返す短い WARN（毎回 24 時間に届かない）は知らせない（累積では見ない）。重大が続く間の値の悪化（ディスクの空きがさらに減るなど）は次の再通知まで知らせない。送れた印を残せない時は送らない（記録を書けない間に同じ通知を重ねない。§3）。

- 送れなかった分は次の回にもう一度（30 分に 1 回まで。出来事の基準も進めない）。`PAUSE` の間は記録だけで、状態も出来事の基準も進めず、明けた後に知らせる
- `PAUSE` は 72 時間で効かなくなる（消し忘れで全部が黙らないように。`monitor_pause=expired` の WARN）
- 本文は 1 行に「対象：何が起きたか → 対応」だけ（例：`【重大】起動ディスク：空きが少ない（18.2） → 要対応`）。文は固定で、値は項目ごとの形（`VALUE_SHAPES`）に合うものだけ通し、それ以外の文字列は `[redacted]` にする（allowlist。項目を足す時はここへも足す）。先頭は `[E-NEXUS Mac Runtime host]`（Trading Lab の通知と取り違えない）。詳細は内部の記録（`YYYY-MM.jsonl`）に残す
- Discord の mention は `allowed_mentions` で全部無効。`discord` 形式の宛先は Discord の webhook の形だけ・redirect に従わない
- 宛先が Discord の webhook なら本文は常に Discord の形（`--webhook-format` の付け忘れで送れなくならない）
- 回復は今回見なかった項目には出ない（外した repo などは state から消える）

### 2-1. 運用要約（四半期）

暦四半期（1・4・7・10 月）の最初の日の 9 時（日本時間）より後の最初の回に、前の四半期を 1 通だけ送る。既存の host-health の job の中で動く（常駐を増やさない）。毎日・毎週・毎月の正常報告はしない。

- 本文は集計の数だけ（稼働率・欠落の回数・重大の件数と対応済み・未解決・軽微な警告・出来事・host-health が送った通知。watchdog の通知は数えない）。項目名・値は載せない（`scripts/lib/quarterly-report.mjs`）
- 送れない時は 6 時間あけて 8 回まで。それでも送れなければその四半期は諦める（`QUARTERLY_GAVE_UP` を記録）。Mac が止まっていて飛ばした四半期は積み上げず、最後の 1 通だけ
- `PAUSE` の間は送らない。state を失った時は同じ四半期を二度送らない側へ倒す
- 下見：`node scripts/host-health.mjs --quarterly-preview [--period 2026Q4]`（送らない・何も書かない）
- **四半期の要約が届かなければ、それ自体が監視の停止の手がかりになる**（§3 の未カバーの最後の網）

### 接続（Human の操作）

1. Discord で専用チャンネルとそのチャンネル専用の Webhook を作る
2. Mac の Terminal で `bash deploy/macos/connect-discord-alerts.sh`（URL の入力はマスクされる。Claude Code の `!` では実行しない）
3. チャンネルに「配送試験」が届き、スクリプトが OK と言えば完了。登録済みの job が `--webhook` を持っていなければ NG と言う

## 3. 監視の停止を見つける

| 止まり方 | 見つけ方 |
|---|---|
| 例外が 3 回続いた | `DISABLED`＋CRIT の通知。止まっている間も 24 時間ごと。Human が消した後は数え直す |
| 記録を書けない | 回数を残せないので時刻の枠で CRIT を知らせる（6 時間ごとの最初の 30 分＝1 日 4 通。`DISABLED` の間に書けなくなった時も同じ。他の通知は送らない） |
| 全体の時間切れ（60 秒） | 失敗に数える（上と同じ） |
| 一時的に止まって再開した | 再開した回に `monitor_gap`（最後の成功から 90 分を超えた空白。再開の回が失敗しても持ち越す） |
| job の解除・ハング・記録の途絶 | `host-health-watchdog`（別の job。`DISABLED` は本体の担当で重ねない）。Mac の再開の直後（起動から 90 分以内・自分の前の回から 90 分超）は判定しない＝偽の CRIT を出さず、次の回に判定する |
| 共有のコードの破損（編集の失敗で import が落ちる） | 両方の job が止まるので、watchdog の入口（`host-health-watchdog-launcher.mjs`・依存なし）が固定の文で知らせる（24 時間ごと）。入口そのものの破損は §3-1 の途絶で見る |
| watchdog の解除・ハング | host-health の `monitor_watchdog`（解除＝CRIT・記録が 3 時間途絶＝CRIT・plist を消せば `residents_changed`）。未登録なら `not_installed` で異常にしない |

watchdog は監視専用：Hermes・Mac・Trading Lab を含めて何も再起動しない。戻し方は `launchctl bootout gui/$(id -u)/com.e-nexus.host-health-watchdog` の後に plist を消す（1 回だけ `residents_changed` と `monitor_config_changed` が届く）。登録も戻すのも :21〜:34 か :51〜:19 に、続けて実行する（間に host-health の回が入ると `not_loaded` の偽の CRIT が出る）。

### 未カバー（Mac の上の監視では知らせられない）

| 止まり方 | 残る手がかり |
|---|---|
| host-health と watchdog が同時に止まる | 再開した時の `monitor_gap`。再開しなければ四半期の要約が届かないこと。§3-1 の導入後は 60 分で途絶として届く |
| Mac の停止 | 再開した時の `rebooted`・`monitor_gap`。§3-1 の外部の死活監視の導入後は 60 分で届く |
| 回線断 | 監視は動き続けるが送れない。戻った回に通知（`recovered_missed` か続く CRIT） |
| 記録を書けない間に起きて解消した CRIT | 通知は送らない（§2）。戻った回の `monitor_gap` と記録だけ |
| Webhook の失効・Discord の障害 | 静かな運用では次の異常か四半期まで分からない。送ろうとした回の `notify_code` が記録に残る（`--report`） |
| host-health の plist から `--webhook` を消す | `monitor_config_changed` は送る先が無く、基準だけ進む。記録の `NO_WEBHOOK` だけが残る |
| スリープの窓 | host-health の後に眠り、起床で watchdog が先に動くと、間が 90 分未満なら偽の CRIT が 1 度出る（この Mac は常時稼働の前提） |
| `DISABLED` を :20〜:35 に消す | watchdog が先に回ると古い記録を見て偽の CRIT が 1 度出る |
| `DISABLED` のまま job が起動しなくなる | watchdog は `DISABLED` を本体に任せるので、本体の 24 時間ごとの通知が止まっても知らせない |
| watchdog の plist に `--webhook` が無い | 動いていても送れない。`connect-discord-alerts.sh` は host-health の job だけ確かめる |

### 3-1. 外部の死活監視（H6）

`--heartbeat` の時、host-health の 1 回分が記録を残した後に、VPS の受け側へ時刻と署名だけを送る（`scripts/lib/heartbeat.mjs`）。受け側は 60 分途絶えたら Discord へ 1 回、戻ったら 1 回知らせる（原因は断定しない。24 時間に 2 回途絶えたら「反復」を 1 通）。受け側と導入は `deploy/vps-heartbeat/README.md`（導入は Human）。

- Keychain の `heartbeat-url`・`heartbeat-token` が無い間は何も送らない
- 送れない状態が 6 時間続けば `heartbeat` の WARN（§2 のとおり続いた時に 1 回）。送った先で署名が合わない時も同じ
- `DISABLED` の間は送らないので、途絶として届く
- VPS・Cloudflare・Discord の停止は知らせられない

## 4. GitHub

`--github-owner <owner> --github-credential credential:E-NEXUS/edl/github-monitor-token` の時だけ、GET で 6 repo を読む（1 回に repo ごと 4 通信まで）。
**無人 job は専用の読み取り token だけを使う**（2026-11-05 Human 決定）。`gh` のログインや classic token は読み書きの範囲が広いので受け取らない（`github_pat_` 以外は `auth_failed`）。Keychain に token が無い間は項目も通信も無い。

| 項目 | 水準 |
|---|---|
| private → public | CRIT（出来事） |
| public → private・既定 branch の変化 | WARN（出来事） |
| 既定 branch の先頭 commit の Actions か commit status の失敗 | WARN（§2 のとおり 24 時間続けば 1 回） |
| Actions の run が 6 時間終わらない | WARN（`ci_stuck`） |
| archived | WARN |
| disabled・見えない repo | CRIT（CI の失敗が続く repo でも悪化としてすぐ知らせる） |
| 通信の失敗 | 6 時間までは unknown（悪化も回復も作らない）。続けば `github_api=unreachable` の WARN |
| token が使えない（失効・権限不足） | `github_api=auth_failed` の WARN（監視自体の失敗） |
| token の期限まで 14 日未満 | `github_api=token_expiring` の WARN |
| Mac の HEAD と GitHub の差 | 別の PC の push で Mac が遅れるのは普通なので値だけ。7 日続けば WARN（未 push は除く） |

未 commit・未 push は `repo:<name>`（runtime-guard・24 時間の猶予）が受け持つ。Trading Lab の repo は見ない。Vault の repo は token の範囲に入れない（中身の読み取りを渡さない）ので、公開範囲もここでは見ない。

### token の発行（Human の操作）

1. GitHub の Settings → Developer settings → Fine-grained tokens → Generate new token。Resource owner は自分、Repository access は **Only select repositories で管理対象の 6 repo だけ**、期限は 1 年以内
2. Repository permissions は **Metadata・Contents・Actions・Commit statuses をすべて Read-only**。それ以外は No access（Contents の読み取りは既定 branch の先頭を見るため）
3. Mac の Terminal で `bash deploy/macos/connect-github-monitor.sh <owner>`。token を Keychain へ入れて検収する（書き込みができる token は不合格で、Keychain から消える）
4. 合格すれば次の回から動く。job の定義は登録済みなので launchd の操作は要らない。戻す時は `bash deploy/macos/keychain-edl.sh delete github-monitor-token`

## 5. バックアップ

GitHub の専用 Private repo へ暗号化して毎日 1 回置く（2026-11-05 Human 決定・H5）。対象は Mac に保全先の無い Mac Runtime の記録だけで、**Time Machine の代わりではない**（Mac 全体は戻らない）。

| 道具 | 役割 |
|---|---|
| `scripts/backup-inventory.mjs` | 棚卸し（結果は標準出力だけ。**公開の場へ貼らない**） |
| `scripts/lib/backup-plan.mjs` | 選別（allowlist）・世代 |
| `scripts/lib/backup-archive.mjs` | AES-256-GCM（改ざん検知）・鍵は passphrase から scrypt・パス名も暗号の中・gzip |
| `scripts/backup-drill.mjs` | 合成データの予行 |
| `scripts/backup-run.mjs` | `plan`・`check`・`run`・`attest-key`・`restore` |
| `deploy/macos/connect-backup.sh` | Human の接続（鍵・token・初回・job の登録） |

- 対象：`~/e-nexus-runtime` の作業メモ・rules・`mac-runtime-state`（Hermes の bundle を除く）・Claude の memory・relay の設定と未送信・host-health の記録
- 除外：コード（GitHub にある）・Keychain の Secret（再発行で戻す）・再生成できるもの・Hermes の home（読めない）・Secret の形のあるファイル・Trading Lab の領域・deny のパターンにあたるファイル（`--deny-file`。公開 repo に置けない識別子を含むのでローカルのファイル。無ければ動かない）

### 本番データを送る条件（1 つでも欠ければ送らない・毎回確かめる）

1. 保存先が Private（API の `private`・`visibility`）
2. token が fine-grained で、他の private repo が見えない（1 repo だけの権限）
3. passphrase が Keychain にあり、**Mac の外の控えから打ち直して一致した記録がある**（passphrase を変えると無効）
4. 合成データの予行が通り、今回のアーカイブを手元で復元して全ファイルが一致する

### 世代と容量

毎日 1 回。新しい 14 世代と月ごとの最新 12 か月分を repo の先頭に残す（1 回に 5 件まで消す）。消したものも Git の履歴に残る。1 アーカイブ 20 MiB まで・repo 全体 800 MiB を超えたら止めて知らせる（整理は Human）。

### 監視

- 送った後に GitHub から読み直し、hash の一致と復号を確かめてから受領票（`~/.enexus/backup/last.json`・`runtime-backup-receipt/v1`）に書く（Vault の「同期＝バックアップではない」：届いたことを別の経路で実証する）
- host-health の `backup_archive`：受領票が無ければ `not_configured`（異常にしない）。2 回続けて失敗で CRIT（Discord へ 1 回。正常時は送らない）。3 日で WARN・7 日で CRIT。**復元の確認が無いか 35 日より古ければ WARN**

### 接続（Human の操作）

1. GitHub で Private repo を作る（`gh repo create` も可。Human-only）
2. fine-grained PAT：Only select repositories で**その repo だけ**、Repository permissions は **Contents を Read and write**（Metadata は Read-only で自動）。期限は 1 年以内
3. passphrase を 20 文字以上で決め、**Mac の外（パスワード管理か紙）に控える**
4. Mac の Terminal で `bash deploy/macos/connect-backup.sh <owner> <repo> <deny-file の絶対パス>`。passphrase・控えからの打ち直し・token の順に聞き、条件を確かめ、初回を送り、job を登録する

### 復元（Mac を失った時）

どの PC でも：① decision-layer を clone ② Private repo の `archives/` から最新を取る ③ `node scripts/backup-run.mjs restore --archive <file> --target <空のフォルダ>`（標準入力に passphrase。Keychain は使わない）。Keychain の Secret は再発行する。

## 6. Hermes へ渡す状態の要約（A2・2026-11-05 Human 承認）

`runtime-status-summary/v1`。host-health の 1 回分の最後に `/Users/Shared/e-nexus-hermes/status/runtime-status.json` を置き換える（`--hermes-user` の時だけ・AI／API なし）。Hermes の OS 権限・toolsets・Human Gate は変えない：読めるのは既存の group（`e-nexus-hermes-read`）で、ファイルは 0640、フォルダは 0750。

- フォルダは host-health が作らない。無ければ何もしない（`status_summary=not_configured`）。**戻す時はフォルダを消すだけ**
- 書けない・フォルダが他人のもの・symlink は `status_summary` の WARN（24 時間続けば 1 回。監視の本体は止めない）
- 監視が止まると更新されないので、Hermes は `generated_at` を見て、古い要約を信じない

渡す：監視の動作（running／paused／stale／disabled）・全体の水準・群ごとの水準と件数（host・hermes・backup・jobs・repos・github）・host／hermes／backup の項目 id と水準。

渡さない：値・パス・hash・pid・回線名・repo 名、それと**見張りの項目**（隔離・固定ファイルの変化・常駐の増減・監視の定義・user 範囲）。見張られる側に検知の中身を渡さないため。allowlist なので、将来足した項目は既定で渡らない。

監視が動いていない時（stale・paused・disabled）の `overall` と各群は `unknown`（古い「正常」を出さない）。項目の無い群も `unknown`。水準は通知の状態ではなく今の観測（`observed`）から取る（送れていない異常を ok と言わない）。

## 7. 役割の分担

| 部品 | 担当 | 持たないもの |
|---|---|---|
| host-health | 決定的な監視・通知 | 修復・AI・承認 |
| Hermes | 24 時間の依頼者・要約者 | 権限の付与・承認・Mac の操作・監視の設定 |
| Claude Code | 開発・修正・調査（Max の範囲） | 監視の代行・常駐 |
| P-Stack | 開発の手順と役割のモデル割り当て | 実行時の判定 |
| Decision Layer | 判定（rules → Jev → Human）。**承認はしない** | 実行 |
| Jev | Decision Layer の Adapter の 1 つ（低コストの判定） | 本体の型・各アプリからの直接の呼び出し |
| REA | 解析（local 範囲の 1 フォルダ） | user 範囲の登録・動く process への接続 |
| Product Hub | 表示と資産の台帳 | 判定・監視 |

### 連携の向き

```
host-health ──記録──▶ data/host-health/（state.json・YYYY-MM.jsonl）
     │                    └─(§6)─▶ 要約ファイル ─読むだけ─▶ Hermes
     └──重大と続く異常だけ──▶ Discord（Human）
Claude Code ──作業の記録──▶ devlog relay ──▶ Vault（Windows）
App・Agent ──CLI／SDK／Gateway──▶ Decision Layer ──▶ Jev（Adapter）
```

- 監視から Hermes・Decision Layer へ自動で「判断」を流さない。異常への対応は Human が決める
- Hermes が判定を求める時は Gateway の契約だけを使う（Jev・core を直接呼ばない）。接続の開始は Human の判断
- 使用量：Claude Code（Max）と Hermes（Anthropic API）は別の財布。監視は どちらも使わない

## 8. Grok Bot（将来・未契約）

未契約なので**作らない・接続しない**。足す時の入口だけ決めておく。

- 読むもの：§6 の要約だけ（承認が要る。Hermes とは別の読み手なので、読み手ごとに判断する）
- 知らせるもの：既存の webhook の契約（`credential:E-NEXUS/edl/<name>`）。Hermes の差し替えなしに足す
- 持たないもの：Mac の操作・監視の設定・承認・Vault 全体・Trading Lab の情報・Secret
- 外部 API への送信になるので、送る項目と保持の条件を契約の前に確かめる。契約・鍵の発行・接続は Human
