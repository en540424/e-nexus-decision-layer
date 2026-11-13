# Hermes の版（v0.23）と iPhone からの確認（2026-11-13・MA-24・調べた結果と手順の案）

## 1. 版

- 入っている版：v0.22.4（commit 4d04303・2026-10-31 の固定）。最新：**v0.23.1**（2026-11-10 公開・618 PR のまとめ・個別の release notes は v0.24.0 へ先送り）、v0.23.0（2026-11-05）
- 調べ方：NousResearch/hermes-agent の公開 source を読むだけ（install・実行はしていない）。根拠は 2026-11-13 の作業ログ

### v0.23 の主な変化（E-NEXUS への影響）

| 変化 | 影響 |
|---|---|
| `-z`（1 回の実行）が gateway の daemon を起動・共有する形に（idle で終わる・`$TMPDIR` に control socket） | **業務の実行の形が変わる**：鍵・環境は最初に起動した process から固まる。sandbox（`scripts/lib/hermes-sandbox.mjs`）の書き先・socket の場所を見直す必要。更新の後に課金なしの確かめ（`hermes-work.mjs` の手順 4）で必ず止まるかを見る |
| `-z` の YOLO（承認を飛ばす）の扱いが不明 | terminal などの toolset を管理の設定で止めているので実害は小さいが、更新の後に確かめる |
| 管理の設定（`/etc/hermes/config.yaml`）の key は全部そのまま。YAML が壊れると黙って無視（fail-open）は同じ | 更新の前に新しい key を足して固定：`webapp.enabled: false`・`plugins.auto_apply: false`（v0.22.4 は知らない key なので更新と同時に入れる） |
| Webapp（ブラウザで Desktop の画面・既定 off・127.0.0.1:9120・1 回だけの sign-in link） | iPhone からの操作の候補。gateway が要る |
| dashboard（`hermes dashboard`・127.0.0.1:9119。loopback 以外は認証が必須・Chat の tab は agent そのもの・**.env を読み書きできる**） | そのまま外へ出すと鍵が画面から見える＝出さない |
| MCP の道具ごとの費用の上限・plugin の自動更新・group chat・Bot の自動の振り分け | 今は使っていない（Hermes の内部 Bot は作らない＝EN司令塔と役割が重なる） |
| 依存の解決（uv 0.12→0.13）・config の移行（browser.*） | 更新は network と hermes の home への書き込みが要る＝Human・sudo |

**判断（推奨）**：今は v0.22.4 のまま業務を始める（sandbox と課金なしの確かめは v0.22.4 の code で設計・確認した）。v0.23 へは、Trading Lab の保守の窓で Human が更新し、直後に次を確かめてから業務に戻す：`hermes --version`・acceptance（managed scope が効く）・`hermes-work.mjs run`（`--paid-ok` なし→課金なしの確かめまで）。戻す時は `pre_update_backup: full` の backup から。

## 2. iPhone から状況を見る・操作する

### 今すぐ使える（追加の公開なし）

**Grok の iPhone アプリ → EN司令塔**：「Mac の状況を詳しく」→ `status.query`（`detail: true`）、「承認待ちは？」→ `task.status`（`view: awaiting_approval`）、「Hermes の結果は？」→ `task.status`（`view: hermes` か task_ref）、「朝のまとめ」→ `report.morning`。すべて読むだけ・Mac の外へ新しい入口を開けない（2026-11-13 実装）。**承認だけは Mac の端末**（変えない）。

### Hermes の画面を iPhone から（Human の判断が要る）

| 案 | 内容 | 危険 | 要るもの |
|---|---|---|---|
| A（推奨） | Tailscale（tailnet の中だけ・HTTPS は Tailscale の証明書）＋ `tailscale serve` で Hermes の **Webapp**（v0.23・sign-in link＋session）だけを tailnet へ | Webapp の画面は Hermes として動く（file の道具などは管理の設定どおり）。tailnet に入れる端末＝操作できる人 | v0.23 への更新・Tailscale の導入（network の変更＝**Trading Lab の保守の窓**・2026-10-22 の決定 Q6 ACL・Q7）・iPhone の Tailscale の login（Human） |
| B | 同じく dashboard を tailnet へ（basic 認証） | **.env（鍵）を画面で読み書きできる**・Chat の tab が agent そのもの | 推奨しない |
| C | 公開のインターネット（Cloudflare 等）へ | 認証の誤りがそのまま外へ | 行わない |

A の手順（Human・保守の窓・1 回）：`tailscaled` を入れ `--accept-dns=false --accept-routes=false`（VM の NAT を変えない）→ ACL で iPhone と Mac だけ → Hermes の `webapp.enabled: true`（管理の設定）・bind は 127.0.0.1 のまま → `tailscale serve --https=443 http://127.0.0.1:9120` → iPhone で Tailscale に login → sign-in link。前後で `scripts/network-baseline.mjs` の写しを取る。検収（Claude Code）：tailnet の外から届かない・HTTP では開かない・Webapp の sign-in 無しで操作できない・Trading Lab の VM の network が変わっていない。
