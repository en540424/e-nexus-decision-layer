/**
 * 失敗した依頼の「次にやること」（2026-11-24・MA-24）。EN司令塔（LLM の Bot）が「失敗の原因と対応は？」に答えられるように、
 * task.status が返す code ごとに決まった文を添える。
 *
 * - 返すのは**この表の決まった文だけ**（依頼の中身・Mac の log・他の依頼元の情報は混ざらない＝外へ出す範囲を広げない）
 * - who：直すのは誰か（requester＝依頼元が params を直せば通る／human＝Mac の Human の判断か設定が要る／wait＝一時的な失敗）
 * - retry：出し直してよいか（new_key＝新しい idempotency_key で 1 回／later＝時間をおいて 1 回／no＝出し直さない）
 * - 自動の再実行はしない（Bot が出し直すかを決める。Human の承認の境は変えない）
 * 表に無い code は「Mac で確かめる・出し直さない」（止まる側）
 */

const STEP = (who, retry, text) => Object.freeze({ who, retry, text });

const TABLE = Object.freeze([
  [/^params_/, STEP('requester', 'new_key', 'params の形の誤り。result.hint があればその形に直して、新しい idempotency_key で 1 回だけ出し直す')],
  [/^(?:replay|idempotency_conflict)$/, STEP('requester', 'new_key', '同じ idempotency_key がもう使われていた。新しい key で出し直す')],
  [/^dropbox_id_invalid$/, STEP('requester', 'new_key', 'file の ID の形の誤り（id: で始まる Dropbox の ID）。正しい ID で、新しい key で出し直す')],
  [/^dropbox_path_(?:not_found|ambiguous|invalid)$/, STEP('requester', 'new_key', 'path が見つからないか 1 つに決まらない。dropbox.list で上の階層の名前を確かめてから、新しい key で出し直す')],
  [/^(?:forbidden_intent|intent_not_allowed|business_not_allowed|channel_not_allowed|unknown_source)$/, STEP('human', 'no', 'この依頼元には許されていない依頼。使えるようにするには Human の承認が要る（出し直さない）')],
  [/^dropbox_(?:id_not_readable|path_not_allowed|read_only|pdf_local_only|business_not_enabled|config_denied_name|output_kind)$/, STEP('human', 'no', '許可の範囲の外（読ませない場所・書かない設定・Mac だけの処理）。広げるには Human の承認が要る（出し直さない）')],
  [/^rejected_by_human$/, STEP('human', 'no', 'Mac で Human が却下した。同じ依頼は出し直さず、理由を Human に聞く')],
  [/^dismissed_by_human$/, STEP('human', 'no', '止まった依頼を Human が確認して閉じた。必要なら Human に確かめてから新しい key で出す')],
  [/^awaiting_approval$/, STEP('human', 'no', 'Mac で Human の承認を待っている。承認されるまで実行しない。出し直さず、後で get_task_status で状態を見る')],
  [/^(?:awaiting_expired|approval_timeout|expired)$/, STEP('human', 'new_key', '承認の期限が切れた（7 日）。まだ必要なら新しい idempotency_key で出し直し、Mac での承認を Human に頼む')],
  [/^dropbox_suspended$/, STEP('wait', 'later', 'Dropbox の読みを失敗が続いたため 15 分止めている。15 分後に新しい key で 1 回だけ出し直す')],
  [/^(?:timeout|dropbox_timeout|dropbox_network|dropbox_unavailable|dropbox_rate_limited|lock_conflict|aborted)$/, STEP('wait', 'later', '一時的な失敗（時間切れ・回線・混雑）。数分おいて新しい key で 1 回だけ出し直す。続く時は status.query {detail:true} で Mac の状態を見る')],
  [/^(?:dropbox_auth|dropbox_forbidden|dropbox_not_configured|dropbox_config_invalid|dropbox_pdf_not_configured|schedule_not_configured|brief_not_configured|hermes_inbox_not_connected|hermes_inbox_unsafe)$/, STEP('human', 'no', 'Mac の設定か資格情報の問題。出し直しても同じ。Human が Mac で確かめる（原因の調べは Claude Code）')],
]);
const DEFAULT_STEP = STEP('human', 'no', 'Mac の側の失敗。自動では出し直さない。Human か Claude Code が Mac で確かめる');

const CODE_RE = /^[a-z0-9_]{1,48}$/;

/** code（無ければ state）から決まった文。形の合わない code も既定の文（code の文字は返さない） */
export function nextStepOf(code, state) {
  const k = typeof code === 'string' && CODE_RE.test(code) ? code : (typeof state === 'string' && CODE_RE.test(state) ? state : '');
  for (const [re, step] of TABLE) if (re.test(k)) return step;
  return DEFAULT_STEP;
}

/** 一覧の項目（code・state を持つ）から、code ごとに 1 つの表（同じ文を何度も返さない）。key は項目の code か state */
export function nextStepsFor(items) {
  const out = {};
  for (const it of items) {
    const k = it.code ?? it.state;
    if (typeof k !== 'string' || !CODE_RE.test(k) || Object.hasOwn(out, k)) continue;
    out[k] = nextStepOf(it.code, it.state);
  }
  return out;
}

export const NEXT_STEP_TABLE_FOR_TEST = TABLE;
