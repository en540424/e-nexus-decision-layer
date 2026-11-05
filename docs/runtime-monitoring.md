# Mac Runtime の監視と連携の仕様

host-health を中心にした、決定的な監視（AI を呼ばない）の契約。正本は Vault の MA-22 ランブック §9-4・§11 と MA-24 で、ここは repo 側の実装の説明。
**この repo は公開なので、ホストの現在の状態・Trading Lab の詳細はここに書かない**（private の Vault へ）。

## 1. 構成

| 部品 | 役割 | 既定 |
|---|---|---|
| `scripts/host-health.mjs` | 30 分ごとの 1 回分：集める・判定する・記録する・変化を知らせる | 通信なし（`--webhook`・`--github-owner` を付けた時だけ） |
| `scripts/lib/runtime-guard.mjs` | Hermes の常駐と隔離・repo・relay・バックアップ・設定の改変 | host-health の中で動く |
| `scripts/lib/github-guard.mjs` | GitHub の公開範囲・CI・repo の異常 | `--github-owner` の時だけ |
| `scripts/lib/alert-policy.mjs` | 知らせる基準と本文の文（§2） | host-health の中で動く |
| `scripts/lib/quarterly-report.mjs` | 四半期の運用要約（§2-1） | host-health の中で動く |
| `scripts/host-health-watchdog.mjs` | host-health の停止を別の job から見る | 生成だけ（登録は Human） |
| `scripts/runtime-status-summary.mjs` | Hermes へ渡す要約のモック（§6） | 一時フォルダにしか書けない |
| `scripts/backup-*.mjs` | バックアップの棚卸しと復元の予行（§5） | 合成データだけ・外へ送らない |

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
| 監視の停止 | すぐ 1 回 | §3。止まっている間は 24 時間ごと |
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
| 記録を書けない | 回数を残せないので時刻の枠で CRIT を知らせる（6 時間ごとの最初の 1 時間。他の通知は送らない） |
| 全体の時間切れ（60 秒） | 失敗に数える（上と同じ） |
| 一時的に止まって再開した | 再開した回に `monitor_gap`（最後の成功から 90 分を超えた空白。再開の回が失敗しても持ち越す） |
| job の解除・ハング・記録の途絶 | `host-health-watchdog`（別の job・登録は Human。`DISABLED` は本体の担当で重ねない）。**未登録の間は再開するまで見えない** |
| watchdog の解除・ハング | host-health の `monitor_watchdog`（解除＝CRIT・記録が 3 時間途絶＝CRIT・plist を消せば `residents_changed`）。未登録なら `not_installed` で異常にしない |

### 未カバー（Mac の上の監視では知らせられない）

| 止まり方 | 残る手がかり |
|---|---|
| host-health と watchdog が同時に止まる | 再開した時の `monitor_gap`。再開しなければ四半期の要約が届かないこと |
| Mac の停止 | 再開した時の `rebooted`・`monitor_gap`。外からの見張りは Human の判断（新しいサービスになる） |
| 回線断 | 監視は動き続けるが送れない。戻った回に通知（`recovered_missed` か続く CRIT） |
| 記録を書けない間に起きて解消した CRIT | 通知は送らない（§2）。戻った回の `monitor_gap` と記録だけ |
| Webhook の失効・Discord の障害 | 静かな運用では次の異常か四半期まで分からない。送ろうとした回の `notify_code` が記録に残る（`--report`） |
| host-health の plist から `--webhook` を消す | `monitor_config_changed` は送る先が無く、基準だけ進む。記録の `NO_WEBHOOK` だけが残る |
| `DISABLED` のまま job が起動しなくなる | watchdog は `DISABLED` を本体に任せるので、本体の 24 時間ごとの通知が止まっても知らせない |
| watchdog の plist に `--webhook` が無い | 動いていても送れない。`connect-discord-alerts.sh` は host-health の job だけ確かめる |

## 4. GitHub

`--github-owner <owner>` の時だけ、1 回に GraphQL の query を 1 通だけ送る（`gh` の既存のログイン。読み取りだけ・新しい鍵なし）。

| 項目 | 水準 |
|---|---|
| private → public | CRIT（出来事） |
| public → private・既定 branch の変化 | WARN（出来事） |
| 既定 branch の先頭 commit の CI が FAILURE／ERROR | WARN（§2 のとおり 24 時間続けば 1 回） |
| archived | WARN |
| disabled・見えない repo | CRIT（CI の失敗が続く repo でも悪化としてすぐ知らせる） |
| 通信・認証の失敗 | 6 時間までは unknown（悪化も回復も作らない）。続けば `github_api` を WARN |
| Mac の HEAD と GitHub の差 | 値だけ。別の PC の push で Mac が遅れるのは普通なので知らせない |

未 commit・未 push は `repo:<name>`（runtime-guard・24 時間の猶予）が受け持つ。Trading Lab の repo は query に入らない。

## 5. バックアップ

`scripts/backup-inventory.mjs`（棚卸し・結果は標準出力だけ。**公開の場へ貼らない**）と `scripts/backup-drill.mjs`（合成データで暗号化→改ざん検知→passphrase 誤り→復元→一致確認）。

- 形式：AES-256-GCM・鍵は passphrase から scrypt。パス名も暗号の中。1 アーカイブ 256 MiB まで
- 実データの入力口は今は無い。保存先と鍵の管理が決まってから、実データ用の入口と受領票（`~/.enexus/backup/last.json`・`runtime-backup-receipt/v1`）を足す
- 監視：受領票が無ければ `backup_archive=not_configured`（異常にしない）。3 日で WARN・7 日で CRIT。**復元の確認が無いか 35 日より古ければ WARN**（戻せると確かめていないものは ok にしない）
- 守らないもの：Keychain の Secret（再発行で戻す）・再生成できるもの（REA の導入・Hermes の Vault の写し）・Trading Lab の領域
- Vault の「同期＝バックアップではない」に従い、保存先へ届いたことは別の場所からの確認で実証する（フォルダがあるだけでは数えない）

## 6. Hermes へ渡す状態の要約（A2・未承認）

`runtime-status-summary/v1`。**承認まで本番へ出さない。書き先の制限はコードにあり、引数では開けない。**

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
     │                    └─(A2 の承認後)─▶ 要約ファイル ─読むだけ─▶ Hermes
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
