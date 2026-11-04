# Mac Runtime の監視と連携の仕様

host-health を中心にした、決定的な監視（AI を呼ばない）の契約。正本は Vault の MA-22 ランブック §9-4・§11 と MA-24 で、ここは repo 側の実装の説明。
**この repo は公開なので、ホストの現在の状態・Trading Lab の詳細はここに書かない**（private の Vault へ）。

## 1. 構成

| 部品 | 役割 | 既定 |
|---|---|---|
| `scripts/host-health.mjs` | 30 分ごとの 1 回分：集める・判定する・記録する・変化を知らせる | 通信なし（`--webhook`・`--github-owner` を付けた時だけ） |
| `scripts/lib/runtime-guard.mjs` | Hermes の常駐と隔離・repo・relay・バックアップ・設定の改変 | host-health の中で動く |
| `scripts/lib/github-guard.mjs` | GitHub の公開範囲・CI・repo の異常 | `--github-owner` の時だけ |
| `scripts/host-health-watchdog.mjs` | host-health の停止を別の job から見る | 生成だけ（登録は Human） |
| `scripts/runtime-status-summary.mjs` | Hermes へ渡す要約のモック（§6） | 一時フォルダにしか書けない |
| `scripts/backup-*.mjs` | バックアップの棚卸しと復元の予行（§5） | 合成データだけ・外へ送らない |

監視は決定的なコードで回す。理由：常時の見回りに課金を載せない・判定を再現できる・Hermes の権限を増やさない。

## 2. 通知（Discord）

宛先は専用チャンネルの専用 Webhook。URL は Keychain の `E-NEXUS/edl/host-health-webhook` だけに置く（引数・ファイル・Git に置かない）。

| 種類 | 通知 |
|---|---|
| CRIT | 発生時すぐ。続けば 3 時間ごと |
| WARN | 発生時 1 回。続けば 12 時間ごと |
| 回復 | 2 回続けて ok になってから 1 回（30 分遅れる代わりに行き来で通知を重ねない） |
| 出来事 | 再起動・回線の切替・Hermes の再起動・固定ファイルの変化・監視の定義と安全 policy の変化・com.e-nexus の常駐の増減・GitHub の公開範囲の変化・監視の空白。各 1 回 |
| 監視の停止 | `DISABLED` になった時 CRIT。止まっている間は 12 時間ごと |
| 正常 | 送らない（定期の「異常なし」は作らない） |

- 送れなかった分は次の回にもう一度（出来事の基準も進めない）。`PAUSE` の間は記録だけで、状態も出来事の基準も進めず、明けた後に知らせる
- `PAUSE` は 72 時間で効かなくなる（消し忘れで全部が黙らないように。`monitor_pause=expired` の WARN）
- 本文は固定のコードと値だけ。値は項目ごとの形（`VALUE_SHAPES`）に合うものだけ通し、それ以外の文字列は `[redacted]` にする（allowlist。項目を足す時はここへも足す）。先頭は `[E-NEXUS Mac Runtime host]`（Trading Lab の通知と取り違えない）
- Discord の mention は `allowed_mentions` で全部無効。`discord` 形式の宛先は Discord の webhook の形だけ・redirect に従わない
- 宛先が Discord の webhook なら本文は常に Discord の形（`--webhook-format` の付け忘れで送れなくならない）
- 回復は今回見なかった項目には出ない（外した repo などは state から消える）

### 接続（Human の操作）

1. Discord で専用チャンネルとそのチャンネル専用の Webhook を作る
2. Mac の Terminal で `bash deploy/macos/connect-discord-alerts.sh`（URL の入力はマスクされる。Claude Code の `!` では実行しない）
3. チャンネルに「配送試験」が届き、スクリプトが OK と言えば完了。登録済みの job が `--webhook` を持っていなければ NG と言う

## 3. 監視の停止を見つける

| 止まり方 | 見つけ方 |
|---|---|
| 例外が 3 回続いた | `DISABLED`＋CRIT の通知。止まっている間も 12 時間ごと。Human が消した後は数え直す |
| 記録を書けない | 回数を残せないので毎回 CRIT を知らせる |
| 全体の時間切れ（60 秒） | 失敗に数える（上と同じ） |
| 一時的に止まって再開した | 再開した回に `monitor_gap`（最後の成功から 90 分を超えた空白。再開の回が失敗しても持ち越す） |
| job の解除・ハング・記録の途絶 | `host-health-watchdog`（別の job・登録は Human。CRIT は 3 時間ごと。`DISABLED` は本体の担当で重ねない） |
| Mac の停止・回線断 | Mac の上の監視では見えない。再開した時の `rebooted`・`monitor_gap` だけ。外からの見張りは Human の判断（新しいサービスになる） |

## 4. GitHub

`--github-owner <owner>` の時だけ、1 回に GraphQL の query を 1 通だけ送る（`gh` の既存のログイン。読み取りだけ・新しい鍵なし）。

| 項目 | 水準 |
|---|---|
| private → public | CRIT（出来事） |
| public → private・既定 branch の変化 | WARN（出来事） |
| 既定 branch の先頭 commit の CI が FAILURE／ERROR | WARN |
| archived・disabled・見えない repo | WARN |
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
     └──変化だけ──▶ Discord（Human）
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
