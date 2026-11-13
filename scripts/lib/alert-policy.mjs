/**
 * Discord へ知らせる基準（2026-11-05 Human 決定・MA-22）。普段は静かに監視し、本当に必要な時だけ知らせる。判定は host-health の decide が使う。
 *
 *   重大（crit）：すぐ 1 回。続けば 24 時間後・48・96・…（上限 7 日）に控えめに再通知。回復は 1 回だけ。送れない間に解消したものも後で 1 回
 *   軽微（warn）：記録だけ。hold の間続いた時に 1 回だけ。再通知も回復の通知もない。crit へ悪化すればすぐ
 *   promote：hold の間続いたら重大として扱う（再通知・回復の通知あり）
 *   出来事：1 回。同じ項目の同じ値は 24 時間に FLAP.max_sends 通まで（値が違えば別に数える・重大は上限の外・超えた分は明けた回に 1 通）。burst は記録だけで、24 時間に 3 回繰り返した時に 1 回
 *   codes：値がコードの一覧の項目は、知らせた後に新しいコードが増えれば知らせ直す
 *   noCooldown：回復の直後の戻りも待たない（セキュリティ・電源・回線・監視の停止）
 *   flap：行き来を数える（重大になりうる項目と再起動・監視の空白）。1 回目はふつうに知らせ、FLAP.window_ms の間に FLAP.count 回に達したら「反復」を 1 通だけ送り、
 *     FLAP.window_ms の間は静かにする。明けた時に続いていれば再通知、落ち着いていれば回復を 1 回。項目ごとに直近 24 時間で FLAP.max_sends 通が上限で、
 *     超える分は持ち越す（続いていれば後で知らせる）。隔離の新しいコードだけは上限を待たない
 * 本文は 1 行に「対象：何が起きたか → 対応」だけ。文言はここの固定文で、値は host-health の関所（VALUE_SHAPES）を通ったものだけ足す。
 */
const HOUR = 3_600_000;

/** 再通知の間隔。1 回目は first、以後は倍にして max で止める */
export const REMIND_MS = Object.freeze({ first: 24 * HOUR, max: 7 * 24 * HOUR });
/** 回復を知らせた直後に同じ項目が重大へ戻っても、この間は知らせない（行き来で通知を重ねない）。続いていれば明けた回に知らせる */
export const COOLDOWN_MS = 6 * HOUR;
/** 回復とするまでに ok が続く回数（30 分ごとなので 30 分遅れる。行き来する項目で通知を重ねない） */
export const RECOVER_RUNS = 2;
export const BURST = Object.freeze({ window_ms: 24 * HOUR, count: 3 });
export const FLAP = Object.freeze({ window_ms: 24 * HOUR, count: 2, max_sends: 3 });
const HOLD_MS = 24 * HOUR;
/** 30 分ごとの job の 2 回先（時刻の揺れで 1 回延びないよう 1 時間より短く） */
const TWO_RUNS_MS = 45 * 60_000;

const CHECK = '確認';
const ACT = '要対応';
const IF_UNKNOWN = '心当たりがなければ要対応';
const name = (id) => id.slice(id.indexOf(':') + 1);

/** [id の形, 基準]。上から最初に合ったもの。target は関数でもよい */
const RULES = Object.freeze([
  [/^disk_free_gib$/, { target: '起動ディスク', what: '空きが少ない', action: ACT, flap: '基準の前後を行き来している' }],
  [/^memory_pressure$/, { target: 'メモリ', what: '逼迫している', action: ACT, flap: '逼迫を繰り返している' }],
  [/^swap_used_gib$/, { target: 'swap', what: '使用量が多い状態が続いている', action: CHECK }],
  [/^load_15m$/, { target: 'CPU の負荷', what: '高い状態が続いている', action: CHECK }],
  [/^thermal$/, { target: '発熱', what: '警告が続いている', action: CHECK }],
  [/^power$/, { target: '電源', what: 'AC 以外で動いている', action: ACT, noCooldown: true, flap: 'AC との行き来を繰り返している' }],
  [/^network_default_route$/, { target: 'ネットワーク', what: '既定経路が無い', action: ACT, noCooldown: true, flap: '断続を繰り返している' }],
  [/^job:/, { target: (id) => `定期 job ${name(id)}`, what: '失敗か長時間の実行が続いている', action: CHECK }],
  [/^data_gib$/, { target: 'Mac Runtime のデータ量', what: '基準を超えている', action: CHECK }],
  [/^hermes_rss_gib$/, { target: 'Hermes のメモリ', what: '使用量が多い', action: ACT, flap: '使用量の増減を繰り返している' }],
  [/^hermes_service$/, { target: 'Hermes', what: '停止している', action: ACT, hold: TWO_RUNS_MS, promote: true, flap: '停止を繰り返している' }],
  [/^hermes_isolation$/, { target: 'Hermes の隔離', what: '崩れている', action: ACT, noCooldown: true, codes: true, flap: '崩れては戻るを繰り返している' }],
  [/^status_summary$/, { target: 'Hermes への状態の要約', what: '書けない状態が続いている', action: CHECK }],
  [/^heartbeat$/, { target: '外部の死活監視への生存信号', what: '送れない状態が続いている', action: CHECK }],
  [/^hermes_restarted$/, { target: 'Hermes', what: '再起動を繰り返している', action: CHECK, burst: true }],
  [/^hermes_files_changed$/, { target: 'Hermes の固定ファイル', what: '変更された', action: IF_UNKNOWN }],
  [/^monitor_config_changed$/, { target: '監視の定義か安全 policy', what: '変更された', action: IF_UNKNOWN }],
  [/^residents_changed$/, { target: 'E-NEXUS の常駐', what: '増減した', action: IF_UNKNOWN }],
  [/^agent_scope$/, { target: 'Claude Code の user 範囲', what: 'E-NEXUS の指示が置かれた', action: ACT, hold: 0, codes: true, flap: '置かれては消えるを繰り返している' }],
  [/^rebooted$/, { target: 'Mac', what: '再起動した', action: '心当たりがなければ確認', flap: '再起動を繰り返している' }],
  [/^network_interface_changed$/, { target: 'ネットワーク', what: '回線の切替を繰り返している', action: CHECK, burst: true }],
  [/^repo:/, { target: (id) => `repo ${name(id)}`, what: '未 commit か未 push が続いている', action: CHECK }],
  [/^relay_outbox$/, { target: 'devlog relay', what: '未送信が残っている', action: CHECK }],
  [/^credential_backup_token$/, { target: 'バックアップの token', what: (value) => (value === 'expired' ? '期限が切れている' : '期限が近い'), action: ACT }],
  [/^backup_history$/, { target: 'バックアップの古い世代', what: '読み直しの検証が失敗したか、古い', action: CHECK }],
  [/^backup_sources$/, { target: 'バックアップの対象', what: 'フォルダが欠けているか読めない', action: CHECK }],
  [/^backup_/, { target: 'バックアップ', what: '失敗したか、古いか、復元を確かめていない', action: CHECK }],
  [/^github_api$/, { target: 'GitHub の見張り', what: '読めない状態か token の期限切れが近い', action: CHECK, codes: true, flap: '読めない状態を繰り返している' }],
  [/^github_visibility_changed$/, { target: 'GitHub の公開範囲', what: '変わった', action: IF_UNKNOWN }],
  [/^github_default_branch_changed$/, { target: 'GitHub の既定 branch', what: '変わった', action: IF_UNKNOWN }],
  [/^github:/, { target: (id) => `GitHub の ${name(id)}`, what: '異常がある', action: CHECK }],
  [/^task_hub_cycle$/, { target: 'Task Hub の回（VPS との受け渡し）', what: (value) => (value === 'stale' ? '30 分以上回っていない' : value === 'not_configured' ? 'VPS の URL か鍵が Keychain に無い（受け渡しが止まっている）' : value === 'paused_breaker' ? '想定外の失敗が続いて止まった（PAUSE＝circuit_open）' : '失敗が続いている'), action: '確かめる（node scripts/task-hub-cycle.mjs を手で 1 回・docs/task-hub.md §14）', hold: TWO_RUNS_MS }],
  [/^task_hub_audit$/, { target: 'Task Hub の監査の記録', what: (value) => (['chain_broken', 'unparseable', 'truncated', 'tip_mismatch', 'tip_missing'].includes(value) ? '鎖が壊れている（分岐・消えた行・改ざんのどれか）' : '読めない'), action: '確かめるまで承認しない（node scripts/task-hub.mjs verify-audit・docs/task-hub.md §13）', hold: 0, codes: true }],
  [/^task_hub_approval$/, { target: 'Task Hub', what: '承認待ちの依頼がある（件数）', action: 'Mac の Terminal で node scripts/task-hub.mjs human → show で全文を読んでから承認か却下（Hermes の依頼は sh deploy/macos/hermes-work-run.sh が承認から実行まで）', hold: 0 }],
  [/^task_hub_queue$/, { target: 'Task Hub の queue', what: (value) => (value === 'check_failed' ? '読めない' : String(value).split(',').map((c) => ({ stalled: '30 分以上実行されない依頼がある', stopped: '途中で止まった依頼がある' })[c] ?? c).join('・')), action: '確かめる（node scripts/runtime-ops.mjs human・docs/task-hub.md §15）', hold: TWO_RUNS_MS, codes: true }],
  [/^business_backup$/, { target: '工程表のバックアップ（週 1 回）', what: (value) => (value === 'stale' ? '8 日以上成功していない' : value === 'config_invalid' ? 'Dropbox の設定が読めない' : '失敗した file がある'), action: 'Grok の EN司令塔か Mac で schedule.backup を 1 回（失敗のコードは mac-runtime-state/task-hub/business-last.json・docs/dropbox-business.md §4）', hold: 0 }],
  [/^docomo_fetch$/, { target: 'ドコモメールの読み取り', what: '失敗が続いている', action: 'Mac の Terminal で docomo-mail-lab の node bin/dml-fetch.mjs --allow-live の出力のコードを確かめる（資格情報の期限・パスワードの変更を含む）', hold: 0 }],
  [/^hermes_jobs$/, { target: 'Hermes の業務', what: (value) => String(value).split(',').map((c) => ({ stuck: '実行中のまま 20 分以上', not_run: '承認済みで 24 時間実行していない', timeout: '時間切れ', no_result: '結果が無いまま終わった', result_rejected: '結果を記録しなかった', interrupted: '途中で止まった' })[c] ?? c).join('・'), action: 'node scripts/hermes-work.mjs status で確かめ、やり直すかを決める（docs/hermes-work.md §11）', hold: 0, codes: true }],
  [/^monitor_blind$/, { target: '監視の項目', what: '読めない状態が 24 時間以上続いている', action: CHECK, hold: 0 }],
  [/^monitor_args$/, { target: '監視の job の定義', what: '通知か見張りの引数が欠けている', action: ACT, hold: 0, codes: true, flap: '欠けては戻るを繰り返している' }],
  [/^monitor_webhook$/, { target: '監視の job の定義', what: (value) => (value === 'no_guard' ? '見張りを止める引数が入っている' : '通知の引数が無く、異常を知らせられない'), action: ACT, hold: 0, codes: true }],
  [/^monitor_fingerprint$/, { target: '監視の固定ファイルの見張り', what: '読めないファイルがある', action: CHECK }],
  [/^monitor_state_reset$/, { target: '監視の記録', what: '基準が初期化された（state が消えたか壊れた）', action: IF_UNKNOWN }],
  [/^notify_channel$/, { target: '通知の Webhook', what: '使えない', action: ACT }],
  [/^monitor_gap$/, { target: '監視', what: '間があいた', action: CHECK, flap: '止まっては戻るを繰り返している' }],
  [/^monitor_pause$/, { target: '監視の PAUSE', what: '期限を過ぎて残っているか、時刻が未来', action: CHECK }],
  [/^monitor_alive$/, { target: '監視', what: '止まっている', action: ACT, noCooldown: true, flap: '止まっては戻るを繰り返している' }],
  [/^monitor_watchdog$/, { target: '監視の見張り', what: '止まっている', action: ACT, noCooldown: true, flap: '止まっては戻るを繰り返している' }],
  [/^host_health$/, { target: '監視', what: (value) => (value === 'state_unwritable' ? '記録を書けない' : '停止した'), action: ACT, hideValue: true }],
  [/^delivery_test$/, { target: '配送試験', what: '異常ではありません', action: '対応不要', hideValue: true }],
]);
const FALLBACK = Object.freeze({ target: (id) => id, what: '異常を検知した', action: CHECK });

/** 項目の基準。hold は無指定なら 24 時間 */
export function ruleOf(id) {
  const rule = RULES.find(([key]) => key.test(id))?.[1] ?? FALLBACK;
  return { hold: HOLD_MS, ...rule };
}

export function remindInterval(reminders = 0) {
  return Math.min(REMIND_MS.first * 2 ** reminders, REMIND_MS.max);
}

/** 通知の 1 行。n は関所を通った後の項目 */
export function alertLine(n) {
  const rule = ruleOf(n.id);
  const target = typeof rule.target === 'function' ? rule.target(n.id) : rule.target;
  if (n.repeat) return `【反復】${target}：${rule.flap}（24 時間に ${n.repeat} 回）→ ${rule.action}。落ち着くまで通知を控える`;
  if (n.change === 'recovered') return `【復旧】${target}：正常に戻った → 対応不要`;
  if (n.change === 'recovered_missed') return `【復旧】${target}：重大な異常があったが通知できなかった。今は正常 → 確認`;
  const tag = { crit: '重大', warn: '警告' }[n.level] ?? '通知';
  const detail = n.value == null || rule.hideValue ? '' : `（${n.value}）`;
  const what = typeof rule.what === 'function' ? rule.what(n.value) : rule.what;
  return `【${tag}${n.change === 'reminder' ? '・継続' : ''}】${target}：${what}${detail} → ${rule.action}`;
}
