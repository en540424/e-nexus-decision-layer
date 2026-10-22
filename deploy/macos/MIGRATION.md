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
| `doctor.sh` | 前提（node≥20・python≥3.10・git・security・launchctl）・有料鍵が env に無いこと・Keychain の有無・repo の状態・LaunchAgent・FileVault／自動ログイン／停電後の自動起動。（2026-10-21）「ホストの安全」節（主回線・ファイアウォール・外から届く待ち受け・リモートログイン・UPS・電源・自動更新・ディスク・メモリ・定期 job 等。PASS／INFO／WARN だけで FAIL は増やさない） | しない（READ-ONLY） |
| `keychain-edl.sh` | Decision Layer 用 Secret（`E-NEXUS/edl/*`）の Keychain 登録・有無・削除（値はマスク入力だけ） | [Human]・TTY |
| `validate.sh` | 全 repo の test・OpenMontage 連携の unittest・有料鍵の境界（probe）・watcher の状態・（任意）Gateway の /health・/ready | しない |
| `rotate-logs.sh` | 常駐ログの世代管理（copy → truncate・sudo 不要） | ログだけ |
| `../../scripts/scheduled-job-service.mjs` | usage-digest・rotate-logs・watcher-cycle・knowledge-refresh・host-health の定期実行の定義を**生成だけ**。launchd の定義は `ProcessType Background`・`LowPriorityIO` | しない |
| `../../scripts/host-health.mjs`（2026-10-21） | ホストの資源と Mac Runtime 自身の定期 job だけを READ-ONLY で見る（Trading Lab の process・VM・MT5・Monitor は見ない）。状態が変わった時だけ知らせ、通知は `--webhook credential:` を付けた時だけ | しない（READ-ONLY） |
| `../../scripts/gateway-service.mjs` | HTTP Gateway の LaunchAgent の定義を**生成だけ**（launchd は `--node` か `--path` が必須） | しない |
| `rea.sh`（2026-10-22） | REA（npm `rea-agents`）を版を固定して `~/e-nexus-runtime/tools/rea/<版>` へ入れる（optional 依存＝Frida・PTY の native 部品なし・install script なし・`npm audit signatures`）・状態・外す。agent への登録はしない（`rea-agents setup` は Claude Code の user 範囲に書くので使わない。1 フォルダの local 範囲の手順は `register-hint`） | `tools/rea` だけ |
| `../../scripts/network-baseline.mjs`（2026-10-22） | 経路・DNS・VPN・待ち受けの基準値を保存し（IP が入るので repo の外・mode 600）、後で比べて想定どおり／想定外を分ける（`--expect tailscale`）。Tailscale・リモートログイン等の前後に使う | しない（READ-ONLY） |
| `../../scripts/hermes-service.mjs`（2026-10-22） | Hermes を専用ユーザーで動かす一式（ユーザー作成・Vault の写し・版を固定した導入・`/etc/hermes` の固定設定・wrapper・LaunchDaemon・検収）を**生成だけ**。実行・登録は Human（順番は生成物の README.txt） | しない |

Windows 上で確かめたこと（2026-09-29）：全 script の `sh -n`／`bash -n`、`doctor.sh`（macOS 以外の分岐）、`make-bundles.sh`（en-product-hub）、`bootstrap.sh`（GitHub 4 repo＋bundle 1 repo の実 clone・2 回目は無変更）、`validate.sh`（実 repo 5 つの test 全通過）、`rotate-logs.sh`、生成器の node test。**macOS でしか動かない部分（`security`・`launchctl`・`fdesetup`・`pmset`）は未実行**＝下の「実機で確かめること」。shellcheck は手元に無く未実施。

## 先に決めること [判断]

1. **無人復帰の方式**：FileVault を有効にすると自動ログインが使えず、停電・再起動の後は誰かがログインするまで LaunchAgent が 1 つも起動しない。LaunchDaemon にすればログイン不要だが、login Keychain を読めない可能性があり（`credential:` が解決できず Gateway は起動を拒否する）、Secret の置き場の再設計が要る。選択肢：(a) FileVault＋手動ログイン（停電後は Human がログイン）／(b) 自動ログイン（FileVault なし）／(c) LaunchDaemon＋System Keychain（再設計）。MA-22 の S0 完了条件「再起動後、人の操作なしで起動しネットワークへ戻る」と S1 のディスク暗号化はこの選択で両立しないことがある
2. **Jev 鍵の Mac 上の置き場**（ランブック §9-2 の 4）：CLI consumer 用は shell profile の `JEV_API_KEY`（Windows の User env と同じ扱い）か、Keychain `E-NEXUS/edl/jev-key-<env>`（HTTP Gateway の env file から `credential:`）
3. **HTTP Gateway を Mac に常駐させるか**：ランブックの既定は「CLI 同居。HTTP 常駐は Hermes 等の HTTP consumer が決まってから」。Worker consumer（crm-executor の preflight・スマホ版）に使うなら外から届く場所（VPS 等）が要る＝台帳 MA-22 行「外から到達が必要な常駐は VPS、内部処理は Mac mini」
4. **Windows 側 watcher を止める時期**（移行確定の判断）
5. **同居する本番 workload**（2026-10-21〜 Trading Lab Stage 1 LIVE の VM）：共通資源（電源・回線・macOS の更新と再起動・pmset・tailnet）の変更は Trading Lab の確認＋Human。手順 1・12・13 の時期は Vault の MA-22 ランブック §11 の保守窓

## 手順

- [ ] 0. [AI済み] Windows で `sh deploy/macos/make-bundles.sh --out <運ぶフォルダ> <親フォルダ>/en-product-hub`（2026-09-29 に動作確認済み。運ぶ直前に作り直す）（2026-10-02：en-product-hub は private remote ができたので、この運搬は省略可。repos.conf は github に変更済み。Mac mini は他の repo と同じく clone する）
- [ ] 1. [Human] 初期設定・Apple ID・判断 1 の設定・電源（停電後の自動起動）・（任意）リモートログイン（SSH）・Tailscale（MA-24 の Q6 ACL・Q7 port を先に確認）
- [ ] 2. [Human] Command Line Tools（最初の `git` で出るダイアログ）・node≥20・python≥3.10 の導入（方法は `〔実機で確定〕`）
- [ ] 2b. [Human・任意] Claude Code の導入と認証（2026-10-01 Vault 正本化：Mac mini は Runtime Node で、Claude Code は **runtime repo の初期構築・保守用**に使ってよい＝ランブック §10）。Vault 編集ノードにはしない（Q2 は (i) のまま。macOS では Vault の Secret 保護 deny が効かないため、Vault クローンを作業ディレクトリにして起動しない）。使う前に手順 5（doctor）と手順 6（鍵境界 probe）を通す
- [ ] 3. [Human] `gh auth login`（private repo の clone に必要）
- [ ] 4. [AI可] `sh deploy/macos/bootstrap.sh --base 〔実機で確定〕 --owner <GitHub の owner> --bundle-dir <bundle を置いた場所>`（最初の decision-layer だけは手で clone する）
- [ ] 5. [AI可] `sh deploy/macos/doctor.sh --base 〔実機で確定〕` が FAIL なし
- [ ] 6. [Human・TTY] en-generate-hub：`bash scripts/secret-migrate.sh set fal`・`set wavespeed` → shell profile の `FAL_KEY`／`WAVESPEED_API_KEY` の export を消す → `bash scripts/secret-boundary-probe.sh` が exit 0（SSH 越しなら login Keychain のロック解除が要る＝`〔実機で確定〕`）
- [ ] 7. [Human・TTY・使うときだけ] `bash deploy/macos/keychain-edl.sh set <name>`（判断 2・3 の結果）
- [ ] 8. [AI可] en-sns-hub の `config.json` を `config.example.json` から作る（`productHubPath` はこの Mac の en-product-hub のパス）。Claude CLI の認証は [Human]（ランブック §9）
- [ ] 9. [AI可] `sh deploy/macos/validate.sh --base 〔実機で確定〕` が FAIL なし
- [ ] 10. [Human・GUI ログイン中] OpenMontage watcher：`python3 integrations/openmontage/enexus_openmontage_autostart.py install` → `status` で loaded → ログインし直して常駐を確認。通知（osascript）の許可・`~/Documents` 等に置いたときの Full Disk Access は `〔実機で確定〕`
- [ ] 11. [Human・判断 4] Windows 側で `autostart uninstall`
- [ ] 12. [任意] 定期実行：`node scripts/scheduled-job-service.mjs --job rotate-logs --target launchd --dir <repo> --base <親> --hour 3 --minute 0`、`--job usage-digest ... --node "$(command -v node)"`（webhook を使うなら `--webhook credential:E-NEXUS/edl/digest-webhook` と手順 7）。登録は [Human]（表示される `launchctl bootstrap`）。（2026-10-21）ホスト監視：`--job host-health --target launchd --dir <repo> --node "$(command -v node)"`（毎時 :20／:50・`--minutes` で変えられる）。登録は [Human]、時期は保守窓の後
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
