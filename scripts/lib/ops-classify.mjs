/**
 * 監視の項目の仕分け（2026-11-05・Batch B／C）。項目ごとに「誰が動くか」と、原因の候補・次の一手を固定の文で持つ。AI／課金なし・判定はしない（監視の水準は host-health が決める）。
 *
 *   auto：監視が再試行や回復を待つ。Human の対応は要らない
 *   ai：Claude Code が調査・修正できる（repo の中の作業など承認の要らない範囲）
 *   human：Human の操作か判断が要る（認証・課金・VPS・Mac の設定・Hermes の権限）
 *
 * 文は全部ここに固定する（値は入れない）。Hermes へ渡すのは cause と next だけで、checks は手元の runtime-ops の表示にだけ使う。
 * 原因は候補で、断定しない。承認の代わりにはならない（Human Gate は別）。
 */
export const OPS_CLASSES = Object.freeze(['auto', 'ai', 'human']);

const TABLE = Object.freeze([
  [/^disk_free_gib$/, { class: 'human', cause: '起動ディスクの空きが基準を下回っている', next: '何を消すかは Human が決める', checks: ['node scripts/runtime-ops.mjs why disk_free_gib', 'df -h /'] }],
  [/^memory_pressure$/, { class: 'human', cause: 'メモリの逼迫。Hermes か同居の負荷の増加', next: '続くなら Human が負荷の元を確かめる', checks: ['node scripts/host-health.mjs --report --days 1'] }],
  [/^swap_used_gib$/, { class: 'auto', cause: '一時的な負荷の増加', next: '続く時だけ通知が出るので待つ', checks: ['node scripts/host-health.mjs --report --days 1'] }],
  [/^load_15m$/, { class: 'auto', cause: '一時的な負荷の増加', next: '続く時だけ通知が出るので待つ', checks: ['node scripts/host-health.mjs --report --days 1'] }],
  [/^thermal$/, { class: 'human', cause: '発熱の警告。設置環境か負荷', next: '続くなら Human が設置環境を確かめる', checks: ['pmset -g therm'] }],
  [/^power$/, { class: 'human', cause: 'AC 以外で動いている。停電か電源の接続', next: 'Human が電源を確かめる', checks: ['pmset -g ps'] }],
  [/^network_default_route$/, { class: 'human', cause: '回線の断か経路の変化', next: 'Human が回線を確かめる', checks: ['route -n get default'] }],
  [/^data_gib$/, { class: 'ai', cause: 'Mac Runtime の記録の増加', next: 'Claude Code が古い記録の整理を提案する', checks: ['du -sh data'] }],
  [/^hermes_rss_gib$/, { class: 'human', cause: 'Hermes のメモリ使用量の増加', next: 'Human が Hermes の停止か継続を判断する', checks: ['node scripts/host-health.mjs --report --days 1'] }],
  [/^hermes_service$/, { class: 'human', cause: 'Hermes が止まっている。wrapper のメモリ停止か STOP の印の可能性', next: 'Human が再開を判断する（AI は再起動しない）', checks: ['launchctl print system/com.e-nexus.hermes'] }],
  [/^job:/, { class: 'ai', cause: '定期 job の失敗か未起動。認証・引数・launchd の登録のどれか', next: 'Claude Code が記録を確かめる。登録の変更は Human', checks: ['node scripts/runtime-ops.mjs acceptance', 'launchctl print gui/$(id -u)/com.e-nexus.<job>'] }],
  [/^repo:/, { class: 'ai', cause: '未 commit か未 push が続いている', next: 'Claude Code が差分を確かめて commit するか、捨てるかを Human に聞く', checks: ['git status --short', 'git log --oneline @{u}..'] }],
  [/^relay_outbox$/, { class: 'ai', cause: '作業ログの封筒が送られていない', next: 'Claude Code が check の後に send する', checks: ['node kit/devlog-relay-sender.mjs status --fetch'] }],
  [/^backup_time_machine$/, { class: 'human', cause: 'Time Machine の保存先か実行の問題', next: 'Human が保存先を確かめる', checks: ['tmutil destinationinfo'] }],
  [/^backup_archive$/, { class: 'ai', cause: 'バックアップの失敗か未実行。認証・容量・除外の条件のどれか', next: 'Claude Code が受領票のコードから調べる。token と passphrase の更新は Human', checks: ['node scripts/backup-run.mjs check --owner <owner> --repo <repo> --deny-file <path>'] }],
  [/^backup_history$/, { class: 'ai', cause: '保存済みの世代の読み直しの失敗', next: 'Claude Code が verify を実行して原因を調べる', checks: ['node scripts/backup-run.mjs verify --owner <owner> --repo <repo> --deny-file <path>'] }],
  [/^credential_backup_token$/, { class: 'human', cause: 'バックアップの token の期限', next: 'Human が token を更新する（docs/runtime-monitoring.md の更新手順）', checks: ['docs/runtime-monitoring.md §10'] }],
  [/^github_api$/, { class: 'human', cause: 'GitHub の見張りの token の失効か期限切れ、または GitHub の障害', next: 'token なら Human が更新する。障害なら待つ', checks: ['docs/runtime-monitoring.md §10'] }],
  [/^github:/, { class: 'ai', cause: 'CI の失敗か repo の状態の変化', next: 'Claude Code が原因を調べる。公開範囲の変更は Human', checks: ['gh run list'] }],
  [/^heartbeat$/, { class: 'human', cause: '外部の死活監視へ信号が届かない。回線・Tunnel・受け側のどれか', next: 'Human が VPS と Cloudflare を確かめる（AI は SSH しない）', checks: ['node scripts/heartbeat-test.mjs'] }],
  [/^notify_channel$/, { class: 'human', cause: '通知の Webhook の失効か削除', next: 'Human が Webhook を作り直す', checks: ['bash deploy/macos/connect-discord-alerts.sh'] }],
  [/^status_summary$/, { class: 'ai', cause: '要約を書けない。フォルダの権限か入力境界の検査', next: 'Claude Code が記録のコードを確かめる', checks: ['ls -ld /Users/Shared/e-nexus-hermes/status'] }],
  [/^monitor_/, { class: 'human', cause: '監視そのものの異常か定義の変更', next: '心当たりがなければ Human が確かめる', checks: ['node scripts/runtime-ops.mjs acceptance'] }],
  [/^hermes_isolation$/, { class: 'human', cause: 'Hermes の隔離の崩れ', next: 'Human がすぐ確かめる', checks: ['node scripts/runtime-ops.mjs why hermes_isolation'] }],
  [/^(?:hermes_files_changed|residents_changed|agent_scope)$/, { class: 'human', cause: '固定の設定か常駐の変更', next: '心当たりがなければ Human が確かめる', checks: ['node scripts/host-health.mjs --report --days 1'] }],
]);
const FALLBACK = Object.freeze({ class: 'human', cause: '分類の無い項目', next: 'Human が確かめる', checks: ['node scripts/runtime-ops.mjs why <id>'] });

export function classify(id) {
  return TABLE.find(([key]) => key.test(id))?.[1] ?? FALLBACK;
}

/** 入力境界が許す固定の文の一覧（cause と next だけ） */
export function fixedTexts() {
  return new Set([...TABLE.map(([, r]) => r), FALLBACK].flatMap((r) => [r.cause, r.next]));
}
