# Mac mini 移行チェックリスト（2026-09-29・Human Last-Mile Activation）

正本は Vault の MA-22 ランブック §9（Windows→Mac 移行・部品ごとの対応・順序・戻し方）。この文書はそれを**上から順に消せる形**にしたもので、ランブックと食い違ったらランブックを正とする。
Mac mini は **2026-09-29 に到着済み（Human 申告）**。実機依存の値（パス・node の場所・PATH 等）は `〔実機で確定〕` のまま残し、推測で埋めない。

印：**[Human]**＝本人が Mac の前で（または SSH 越しに）行う／**[AI可]**＝SSH 等で Claude Code が実行できる／**[判断]**＝Human の決定。

## 道具（この deploy/macos/）

| file | 何をする | 変更するか |
|---|---|---|
| `repos.conf` | 置く repo の一覧（source＝github／bundle・test の種類） | — |
| `make-bundles.sh` | remote の無い repo（en-product-hub）を git bundle にする（Windows の Git Bash で実行） | しない |
| `bootstrap.sh` | 無い repo だけ clone（github は `--owner`・bundle は `--bundle-dir`）・依存のある repo だけ `npm ci`。既存 repo には触らない | clone・npm ci だけ |
| `doctor.sh` | 前提（node≥20・python≥3.10・git・security・launchctl）・有料鍵が env に無いこと・Keychain の有無・repo の状態・LaunchAgent・FileVault／自動ログイン／停電後の自動起動 | しない（READ-ONLY） |
| `keychain-edl.sh` | Decision Layer 用 Secret（`E-NEXUS/edl/*`）の Keychain 登録・有無・削除（値はマスク入力だけ） | [Human]・TTY |
| `validate.sh` | 全 repo の test・OpenMontage 連携の unittest・有料鍵の境界（probe）・watcher の状態・（任意）Gateway の /health・/ready | しない |
| `rotate-logs.sh` | 常駐ログの世代管理（copy → truncate・sudo 不要） | ログだけ |
| `../../scripts/scheduled-job-service.mjs` | usage digest・rotate-logs を毎日動かす LaunchAgent の定義を**生成だけ** | しない |
| `../../scripts/gateway-service.mjs` | HTTP Gateway の LaunchAgent の定義を**生成だけ**（launchd は `--node` か `--path` が必須） | しない |

Windows 上で確かめたこと（2026-09-29）：全 script の `sh -n`／`bash -n`、`doctor.sh`（macOS 以外の分岐）、`make-bundles.sh`（en-product-hub）、`bootstrap.sh`（GitHub 4 repo＋bundle 1 repo の実 clone・2 回目は無変更）、`validate.sh`（実 repo 5 つの test 全通過）、`rotate-logs.sh`、生成器の node test。**macOS でしか動かない部分（`security`・`launchctl`・`fdesetup`・`pmset`）は未実行**＝下の「実機で確かめること」。shellcheck は手元に無く未実施。

## 先に決めること [判断]

1. **無人復帰の方式**：FileVault を有効にすると自動ログインが使えず、停電・再起動の後は誰かがログインするまで LaunchAgent が 1 つも起動しない。LaunchDaemon にすればログイン不要だが、login Keychain を読めない可能性があり（`credential:` が解決できず Gateway は起動を拒否する）、Secret の置き場の再設計が要る。選択肢：(a) FileVault＋手動ログイン（停電後は Human がログイン）／(b) 自動ログイン（FileVault なし）／(c) LaunchDaemon＋System Keychain（再設計）。MA-22 の S0 完了条件「再起動後、人の操作なしで起動しネットワークへ戻る」と S1 のディスク暗号化はこの選択で両立しないことがある
2. **Jev 鍵の Mac 上の置き場**（ランブック §9-2 の 4）：CLI consumer 用は shell profile の `JEV_API_KEY`（Windows の User env と同じ扱い）か、Keychain `E-NEXUS/edl/jev-key-<env>`（HTTP Gateway の env file から `credential:`）
3. **HTTP Gateway を Mac に常駐させるか**：ランブックの既定は「CLI 同居。HTTP 常駐は Hermes 等の HTTP consumer が決まってから」。Worker consumer（crm-executor の preflight・スマホ版）に使うなら外から届く場所（VPS 等）が要る＝台帳 MA-22 行「外から到達が必要な常駐は VPS、内部処理は Mac mini」
4. **Windows 側 watcher を止める時期**（移行確定の判断）

## 手順

- [ ] 0. [AI済み] Windows で `sh deploy/macos/make-bundles.sh --out <運ぶフォルダ> <親フォルダ>/en-product-hub`（2026-09-29 に動作確認済み。運ぶ直前に作り直す）
- [ ] 1. [Human] 初期設定・Apple ID・判断 1 の設定・電源（停電後の自動起動）・（任意）リモートログイン（SSH）・Tailscale（MA-24 の Q6 ACL・Q7 port を先に確認）
- [ ] 2. [Human] Command Line Tools（最初の `git` で出るダイアログ）・node≥20・python≥3.10 の導入（方法は `〔実機で確定〕`）
- [ ] 3. [Human] `gh auth login`（private repo の clone に必要）
- [ ] 4. [AI可] `sh deploy/macos/bootstrap.sh --base 〔実機で確定〕 --owner en540424 --bundle-dir <bundle を置いた場所>`（最初の decision-layer だけは手で clone する）
- [ ] 5. [AI可] `sh deploy/macos/doctor.sh --base 〔実機で確定〕` が FAIL なし
- [ ] 6. [Human・TTY] en-generate-hub：`bash scripts/secret-migrate.sh set fal`・`set wavespeed` → shell profile の `FAL_KEY`／`WAVESPEED_API_KEY` の export を消す → `bash scripts/secret-boundary-probe.sh` が exit 0（SSH 越しなら login Keychain のロック解除が要る＝`〔実機で確定〕`）
- [ ] 7. [Human・TTY・使うときだけ] `bash deploy/macos/keychain-edl.sh set <name>`（判断 2・3 の結果）
- [ ] 8. [AI可] en-sns-hub の `config.json` を `config.example.json` から作る（`productHubPath` はこの Mac の en-product-hub のパス）。Claude CLI の認証は [Human]（ランブック §9）
- [ ] 9. [AI可] `sh deploy/macos/validate.sh --base 〔実機で確定〕` が FAIL なし
- [ ] 10. [Human・GUI ログイン中] OpenMontage watcher：`python3 integrations/openmontage/enexus_openmontage_autostart.py install` → `status` で loaded → ログインし直して常駐を確認。通知（osascript）の許可・`~/Documents` 等に置いたときの Full Disk Access は `〔実機で確定〕`
- [ ] 11. [Human・判断 4] Windows 側で `autostart uninstall`
- [ ] 12. [任意] 定期実行：`node scripts/scheduled-job-service.mjs --job rotate-logs --target launchd --dir <repo> --base <親> --hour 3 --minute 0`、`--job usage-digest ... --node "$(command -v node)"`（webhook を使うなら `--webhook credential:E-NEXUS/edl/digest-webhook` と手順 7）。登録は [Human]（表示される `launchctl bootstrap`）
- [ ] 13. [判断 3 の後] HTTP Gateway の常駐：`docs/deploy-production-gateway.md`（`gateway-service.mjs --target launchd --node "$(command -v node)"`・env file・token・release・smoke）

## 実機で確かめること（Windows では確かめられない）

- `security find-generic-password`・`add-generic-password -w` のプロンプト（SSH 越しのロック解除を含む）
- `launchctl bootstrap／print／kickstart` と LaunchAgent の再ログイン後の起動
- `rotate-logs.sh` の copy → truncate の後、launchd の書き込みがファイルの先頭から続くこと（追記モードで開いている前提）
- `fdesetup isactive`・`pmset -g` の表示と判断 1 の結果
- osascript 通知の許可ダイアログ

## 更新・戻し方

- 更新：各 repo で `git pull`（fast-forward のみ）→ `validate.sh` → `autostart restart`（watcher）／Gateway は deploy doc §3 の昇格手順
- 戻し方：Mac で `autostart uninstall` → Windows で `autostart install`（有料鍵は Windows の資格情報マネージャーと Mac の Keychain に並行して持てる：ランブック §9-3）。repo は消さない（手元の変更を失わない）
