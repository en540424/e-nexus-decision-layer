/**
 * Dropbox の業務基盤：実の Dropbox への最初の接続（2026-11-16・読むだけの確かめ）で分かったことの再発防止。ここでは実の Dropbox・資格情報には接続しない
 * （模擬と作り物だけ。名前は作り物）。
 *   結果の大きさ：日本語の名前の一覧・長いカルテ・実の形の工程表は Task Hub の結果の上限（16 KiB）を越え、runner が想定外（result_invalid）にしていた
 *   工程表：日付が横に並ぶ表を日付で抜き出す・共有の文字のふりがな（rPh）を文字に足さない・空の項目（<si/>）で番号をずらさない
 *   全角の名前：Task Hub の受け口は依頼の文字を NFKC に揃える＝全角を含む実の名前（「工　事」「Q＆A」「（仮称）」）は依頼の文字のままでは Dropbox に無い → 実の名前に直す
 *   設定の照らし（dropbox-preflight）：全角半角・空白のちがいで無い path・同じ名前の file が別の場所に在る・種類の違い・書きの app
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDropbox } from '../scripts/lib/dropbox/client.mjs';
import { resolveReal } from '../scripts/lib/dropbox/resolve.mjs';
import { loadScopes, assertReadable, browsable, matchRoot } from '../scripts/lib/dropbox/scope.mjs';
import { approve } from '../scripts/lib/task-hub/approval.mjs';
import { workingName } from '../scripts/lib/task-hub/business-handlers.mjs';
import { newKarte } from '../scripts/lib/business/karte.mjs';
import { readCalendar, readSheetRows } from '../scripts/lib/xlsx/workbook.mjs';
import { bounded, clip, fitList, RESULT_LIST_BYTES } from '../scripts/lib/task-hub/business-handlers.mjs';
import { MAX_BODY_BYTES } from '../scripts/lib/task-hub/wire.mjs';
import { submitLocal } from '../scripts/lib/task-hub/intake.mjs';
import { runOnce } from '../scripts/lib/task-hub/runner.mjs';
import { loadCatalog } from '../scripts/lib/task-hub/policy.mjs';
import { checkSpec } from '../scripts/lib/task-hub/envelope.mjs';
import { describe, foldName, preflight } from '../scripts/dropbox-preflight.mjs';
import { startDropboxMock } from './dropbox-mock.mjs';
import { envelope, makeEnv } from './task-hub-helpers.mjs';
import { bigCalendar, calendarWorkbook } from './xlsx-calendar-fixture.mjs';
import { fixtureWorkbook } from './xlsx-fixture.mjs';

const bytesOf = (x) => Buffer.byteLength(JSON.stringify(x), 'utf8');
const TODAY = '2026-11-16';
// 実の名前の形をまねた作り物：半角のかっこ・名前の中の全角の空白・全角の＆
const SCHED = '/(株)会社A/年間予定表.xlsx';
const DROPBOX = { businesses: { 'biz-a': { read_roots: ['/業務/工\u3000事', '/業務/現場管理', '/業務/Q＆A'], schedule_files: [SCHED], estimate_roots: ['/業務/見積書の原本'], output_root: '/biz-a' } } };

async function world({ schedule = bigCalendar() } = {}) {
  const read = await startDropboxMock({ role: 'read' });
  const write = await startDropboxMock({ role: 'write' });
  const dir = mkdtempSync(path.join(tmpdir(), 'dbx-live-'));
  read.put(SCHED, schedule);
  read.put('/業務/過去の予定表/年間予定表.xlsx', fixtureWorkbook()); // 同じ名前の古い写し
  read.put('/業務/工\u3000事/現場A/平面図.pdf', Buffer.from('%PDF-1.4 fake'));
  read.put('/業務/現場管理/工程写真.pdf', Buffer.from('%PDF-1.4 fake'));
  read.put('/業務/Q＆A/資料.pdf', Buffer.from('%PDF-1.4 fake'));
  read.put('/業務/見積書の原本/現場A_見積書.xlsx', fixtureWorkbook());
  read.put('/(株)会社A/業務/工\u3000事/現場A/平面図.pdf', Buffer.from('%PDF-1.4 old')); // 使っていない側の同じ名前の木
  const reader = read.client(createDropbox);
  const writer = write.client(createDropbox);
  const services = { backupDir: dir, historyDir: dir, dropbox: (role) => (role === 'read' ? reader : writer) };
  const close = async () => { await read.close(); await write.close(); rmSync(dir, { recursive: true, force: true }); };
  return { read, write, reader, writer, dir, services, close };
}
function hub(w, extra = {}) {
  const env = makeEnv({ config: { dropbox: DROPBOX, utc_offset_minutes: 540, ...extra } });
  const config = { ...env.config, services: w.services };
  const run = () => runOnce({ store: env.store, policy: { ...env.policy, config }, handlers: env.handlers, now: () => (env.clock.t += 1000) });
  const submit = async (intent, params, business = 'biz-a') => (await submitLocal(envelope({ intent, params, business }), { store: env.store, policy: env.policy, now: env.clock.t })).task_id;
  const res = (id) => env.store.readTask(id);
  const approved = async (intent, params) => { const id = await submit(intent, params); approve(env.store, id, { confirm: res(id).content_digest.slice(0, 12), isTTY: true, now: env.clock.t }); return id; };
  return { env, run, submit, res, approved };
}

// ─── xlsx：共有の文字 ───
test('工程表：共有の文字のふりがな（rPh）を文字に足さない・空の項目（<si/>）で後ろの番号がずれない', () => {
  const wb = calendarWorkbook({ sheets: [{ name: '表', plain: true, items: [{ r: 1, col: 1, text: '山田邸' }, { r: 2, col: 1, text: '足場架け', n: 3 }] }] });
  const r = readSheetRows(wb);
  assert.deepEqual(r.rows.map((x) => x.cells.map((c) => c.text)), [['山田邸'], ['足場架け', '3']], 'ふりがな「フリガナ」が後ろに付かない・0 番の空の項目のぶんずれない');
  assert.equal(readSheetRows(wb, { query: 'フリガナ' }).matched, 0, 'ふりがなは検索にも当たらない');
  assert.equal(readCalendar(wb, { today: TODAY }), null, '日付の見出しが無い表は日付の読み方にしない');
});

// ─── 工程表：日付で読む ───
const SMALL = () => calendarWorkbook({ sheets: [
  { name: '新', start: '2026-11-10', days: 20,
    labels: [{ r: 3, a: '第1班', b: '職長ア' }, { r: 5, a: '第2班' }, { r: 7, a: '応援', rows: 1 }],
    items: [
      { date: '2026-11-16', r: 3, text: '山田邸\u3000架け', n: 3 },
      { date: '2026-11-16', r: 4, text: '午後\u3000佐藤邸' }, // 結合された名前の 2 行目
      { date: '2026-11-17', r: 5, text: '鈴木ビル', n: 4, spanDays: 2 }, // 2 日にまたがる結合
      { date: '2026-11-18', r: 7, text: 'Ａ邸\u3000払い' },
      { date: '2026-11-18', r: 9, text: '名前の無い行' },
      { date: '2026-11-25', r: 3, text: '山田邸\u3000払い', n: 2 },
    ] },
  { name: '旧', start: '2026-10-25', days: 20, labels: [{ r: 3, a: '第1班' }], items: [{ date: '2026-11-11', r: 3, text: '古い sheet の予定' }, { date: '2026-10-30', r: 3, text: '先月の現場' }] },
] });

test('工程表：既定は今日から 7 日・行の名前は結合された下の行にも付く・何日かにまたがる cell は各日に出る・曜日が付く', () => {
  const r = readCalendar(SMALL(), { today: TODAY });
  assert.equal(r.mode, 'calendar');
  assert.equal(r.sheet, '新');
  assert.deepEqual(r.range, { from: '2026-10-25', to: '2026-11-29' }, '全部の sheet を合わせた期間');
  assert.deepEqual([r.from, r.to, r.days.length], ['2026-11-16', '2026-11-22', 7]);
  assert.deepEqual(r.days[0], { date: '2026-11-16', weekday: '月', items: [{ r: 3, label: '第1班 職長ア', text: '山田邸\u3000架け 3' }, { r: 4, label: '第1班 職長ア', text: '午後\u3000佐藤邸' }] });
  assert.deepEqual(r.days[1].items, [{ r: 5, label: '第2班', text: '鈴木ビル 4' }], '17 日');
  assert.deepEqual(r.days[2].items, [{ r: 5, label: '第2班', text: '鈴木ビル' }, { r: 7, label: '応援', text: 'Ａ邸\u3000払い' }, { r: 9, text: '名前の無い行' }], '18 日：またがる cell も出る・名前の無い行は label なし（上の行の名前を借りない）');
  assert.deepEqual(r.days[3].items, [], '予定の無い日も日として返す');
  assert.equal(r.truncated, false);
});

test('工程表：1 日・期間・古い sheet・sheet の指定・どの sheet にも無い日（out_of_range と各 sheet の期間）', () => {
  const wb = SMALL();
  assert.deepEqual(readCalendar(wb, { today: TODAY, from: '2026-11-25', to: '2026-11-25' }).days, [{ date: '2026-11-25', weekday: '水', items: [{ r: 3, label: '第1班 職長ア', text: '山田邸\u3000払い 2' }] }]);
  // 期間が重なる日は並びの先（新しい sheet）から読む。古い sheet にしか無い日は古い sheet から
  assert.equal(readCalendar(wb, { today: TODAY, from: '2026-11-11', to: '2026-11-11' }).sheet, '新');
  const old = readCalendar(wb, { today: TODAY, from: '2026-10-30', to: '2026-10-30' });
  assert.deepEqual([old.sheet, old.days[0].items[0].text], ['旧', '先月の現場']);
  assert.equal(readCalendar(wb, { today: TODAY, sheet: '旧', from: '2026-11-11', to: '2026-11-11' }).days[0].items[0].text, '古い sheet の予定', 'sheet を指定すればその sheet');
  assert.throws(() => readCalendar(wb, { today: TODAY, sheet: '無い' }), { code: 'xlsx_sheet_not_found' });
  const far = readCalendar(wb, { today: TODAY, from: '2030-01-01' });
  assert.equal(far.out_of_range, true);
  assert.deepEqual(far.ranges, [{ sheet: '新', from: '2026-11-10', to: '2026-11-29' }, { sheet: '旧', from: '2026-10-25', to: '2026-11-13' }]);
  // 在る期間の終わりをまたぐ：在るぶんだけ返す（その先はどの sheet にも無い＝続きは無い）
  const edge = readCalendar(wb, { today: TODAY, from: '2026-11-27' });
  assert.deepEqual([edge.to, edge.days.length, edge.truncated, edge.next_from], ['2026-11-29', 3, false, undefined]);
  // 期間が 2 つの sheet にまたがる：日ごとに、その日を含む最初の sheet から（重なる日は新しい sheet・古い sheet にしか無い日は古い sheet）
  const cross = readCalendar(wb, { today: TODAY, from: '2026-11-08', to: '2026-11-12' });
  assert.deepEqual([cross.sheet, cross.sheets_used, cross.days.length], ['旧', ['新', '旧'], 5]);
  assert.deepEqual(cross.days.map((d) => d.items.map((x) => x.text)), [[], [], [], [], []], '11-11 の「古い sheet の予定」は、新しい sheet がその日を持つので出ない');
  assert.equal(readCalendar(wb, { today: TODAY, sheet: '旧', from: '2026-11-08', to: '2026-11-12' }).days[3].items[0].text, '古い sheet の予定', 'sheet を指定した時だけ古い側');
  // 在る期間より前から始まる長い期間：在る期間に寄せてから 31 日で切る（空の結果と進まない next_from を返さない）
  const early = readCalendar(wb, { today: TODAY, from: '2000-01-01', to: '2026-12-31' });
  assert.deepEqual([early.from, early.days.length, early.truncated, early.next_from, early.days[5].items[0].text], ['2026-10-25', 31, true, '2026-11-25', '先月の現場']);
  assert.deepEqual([far.from, far.to], ['2030-01-01', '2030-01-07']);
  // 今日がどの sheet にも無い（新しい年の sheet がまだ無い）：既定の読み方は out_of_range
  assert.equal(readCalendar(wb, { today: '2027-03-01' }).out_of_range, true);
});

test('工程表：query は今日以後の項目（現場の文字か行の名前）・全角半角は同じに探す・期間をつければ過去も', () => {
  const wb = SMALL();
  const q = readCalendar(wb, { today: TODAY, query: '山田' });
  assert.deepEqual([q.from, q.to, q.matched], ['2026-11-16', '2026-11-29', 2]);
  assert.deepEqual(q.hits, [{ date: '2026-11-16', r: 3, label: '第1班 職長ア', text: '山田邸\u3000架け 3' }, { date: '2026-11-25', r: 3, label: '第1班 職長ア', text: '山田邸\u3000払い 2' }]);
  assert.equal(readCalendar(wb, { today: TODAY, query: 'a邸' }).hits[0].text, 'Ａ邸\u3000払い', '全角の Ａ も半角の a で当たる（返す文字は元のまま）');
  assert.deepEqual(readCalendar(wb, { today: TODAY, query: '第2班' }).hits.map((x) => x.date), ['2026-11-17', '2026-11-18'], '行の名前でも探せる');
  assert.equal(readCalendar(wb, { today: TODAY, query: '先月' }).matched, 0, '今日以後・今日を含む sheet だけ');
  assert.equal(readCalendar(wb, { today: TODAY, query: '先月', from: '2026-10-25', to: '2026-11-13' }).hits[0].text, '先月の現場');
  assert.equal(readCalendar(wb, { today: '2027-03-01', query: '山田' }).matched, 2, '今日がどの sheet にも無ければ、最初の sheet の全部から探す');
});

test('工程表：結果は bytes の上限の内側（長い期間は 31 日まで・越える手前で切って next_from）', () => {
  const wb = bigCalendar();
  const week = readCalendar(wb, { today: TODAY });
  assert.equal(week.days.length, 7);
  assert.ok(week.days.every((d) => d.items.length === 10));
  assert.ok(bytesOf(week) < MAX_BODY_BYTES);
  const long = readCalendar(wb, { today: TODAY, from: '2026-09-01', to: '2026-12-31' });
  assert.equal(long.truncated, true);
  assert.ok(bytesOf(long) <= 10_000 + 400, `${bytesOf(long)}`);
  assert.equal(long.next_from, new Date(Date.parse(`${long.to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), '続きは next_from から');
  const next = readCalendar(wb, { today: TODAY, from: long.next_from, to: '2026-12-31' });
  assert.equal(next.from, long.next_from);
  const q = readCalendar(wb, { today: TODAY, from: '2026-09-01', to: '2027-01-15', query: '邸' });
  assert.equal(q.matched, 1370);
  assert.equal(q.truncated, true);
  assert.ok(q.hits.length > 20 && q.hits.length < q.matched);
  assert.ok(bytesOf(q) <= 10_000 + 400);
  assert.ok(q.next_from > q.hits.at(-1).date && !q.hits.some((h) => h.date === q.next_from), '日の境で切る＝next_from の日の項目はまだ 1 つも返していない');
  // next_from で聞き直して全部を集めると、落ちも重なりも無い
  const seen = [];
  let from = '2026-09-01';
  for (let i = 0; i < 200 && from; i += 1) { const r = readCalendar(wb, { today: TODAY, from, to: '2027-01-15', query: '邸' }); seen.push(...r.hits); from = r.next_from ?? null; }
  assert.equal(seen.length, 1370);
  assert.equal(new Set(seen.map((h) => `${h.date}|${h.r}`)).size, 1370);
  // 日ごとの読み方も同じ（31 日ずつ・bytes で切れても続きから）
  const days = [];
  from = '2026-09-01';
  for (let i = 0; i < 200 && from && from <= '2027-01-15'; i += 1) { const r = readCalendar(wb, { today: TODAY, from, to: '2027-01-15' }); days.push(...r.days); from = r.next_from ?? null; }
  assert.equal(days.length, 137);
  assert.equal(new Set(days.map((d) => d.date)).size, 137);
  assert.equal(days.reduce((n, d) => n + d.items.length, 0), 1370);
});

test('工程表：1 日だけで上限を越える時は、その日を途中まで返して次の日へ進む（同じ日を聞き直し続けない）', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ date: '2026-11-16', r: 3 + i, text: `現場${String(i).padStart(2, '0')}\u3000${'足場の組立と解体の作業'.repeat(2)}` }));
  const wb = calendarWorkbook({ sheets: [{ name: '表', start: '2026-11-10', days: 20, items: [...many, { date: '2026-11-17', r: 3, text: '次の日' }] }] });
  const r = readCalendar(wb, { today: TODAY, budget: 3000 });
  assert.deepEqual([r.days.length, r.days[0].partial, r.truncated, r.next_from], [1, true, true, '2026-11-17']);
  assert.ok(r.days[0].items.length > 0 && r.days[0].items.length < 60 && bytesOf(r) <= 3000);
  assert.equal(r.days[0].omitted, 60 - r.days[0].items.length, '落とした数');
  const q = readCalendar(wb, { today: TODAY, query: '現場', budget: 3000 });
  assert.deepEqual([q.partial_date, q.truncated, q.next_from, q.matched, q.omitted], ['2026-11-16', true, '2026-11-17', 60, 60 - q.hits.length]);
  assert.ok(q.hits.length > 0 && q.hits.length < 60 && bytesOf(q) <= 3000);
  // 頼んだ期間がその 1 日だけなら、続きの日は返さない（期間の外へ進ませない）
  const one = readCalendar(wb, { today: TODAY, from: '2026-11-16', to: '2026-11-16', budget: 3000 });
  assert.deepEqual([one.days[0].partial, one.truncated, one.next_from], [true, true, undefined]);
  const oneQ = readCalendar(wb, { today: TODAY, from: '2026-11-16', to: '2026-11-16', query: '現場', budget: 3000 });
  assert.deepEqual([oneQ.partial_date, oneQ.next_from], ['2026-11-16', undefined]);
});

test('工程表：中身の無い行（<row …/>）・数式の文字の結果・曜日の行の余分な cell があっても、行の番号と名前がずれない', async () => {
  const { entryData, makeEntry, readZip, writeZip } = await import('../scripts/lib/xlsx/zip.mjs');
  const edit = (bytes, name, fn) => writeZip(readZip(bytes).map((e) => (e.name === name ? makeEntry(name, Buffer.from(fn(entryData(e).toString('utf8'))), e) : e)));
  const base = calendarWorkbook({ sheets: [{ name: '表', start: '2026-11-10', days: 20, labels: [{ r: 3, a: '第1班' }, { r: 5, a: '第2班' }], items: [{ date: '2026-11-16', r: 3, text: '山田邸' }, { date: '2026-11-16', r: 5, text: '佐藤邸' }] }] });
  const want = [{ r: 3, label: '第1班', text: '山田邸' }, { r: 5, label: '第2班', text: '佐藤邸' }];
  assert.deepEqual(readCalendar(base, { today: TODAY }).days[0].items, want);
  // Excel は高さだけ決めた空の行を <row …/> と書く
  const selfClosing = edit(base, 'xl/worksheets/sheet1.xml', (x) => x.replace('<row r="3"', '<row r="2" spans="1:43" ht="12" customHeight="1"/><row r="3"').replace('<row r="5"', '<row r="4" ht="12" customHeight="1"/><row r="5"').replace(/<row r="2" spans="1:43">[\s\S]*?<\/row>/, ''));
  assert.deepEqual(readCalendar(selfClosing, { today: TODAY }).days[0].items, want, '空の行が次の行を飲み込まない');
  const sato = readSheetRows(selfClosing, { query: '佐藤' }).rows;
  assert.deepEqual([sato.length, sato[0].r, sato[0].cells.every((c) => c.ref.endsWith('5'))], [1, 5, true], '行の番号と cell の番地が合う');
  // 曜日の行に余分な cell（最後の列のメモ）が 1 つ在っても曜日の行のまま
  const stray = edit(base, 'xl/worksheets/sheet1.xml', (x) => x.replace(/(<row r="2"[^>]*>[\s\S]*?)(<\/row>)/, '$1<c r="ZZ2" t="inlineStr"><is><t>この行は曜日（メモ）</t></is></c>$2'));
  const st = readCalendar(stray, { today: TODAY });
  assert.deepEqual([st.days[0].weekday, st.days[0].items], ['月', want]);
  // 数式の文字の結果（t="str"）・真偽・エラーは数として読まない＝日付の見出しに数えない
  const str = edit(base, 'xl/worksheets/sheet1.xml', (x) => x.replace('</sheetData>', '<row r="40"><c r="C40" t="str"><f>TEXT(1,"0")</f><v>46000</v></c><c r="E40" t="e"><v>#N/A</v></c><c r="G40" t="b"><v>1</v></c></row></sheetData>'));
  const row40 = readSheetRows(str, { maxRows: 100 }).rows.find((x) => x.r === 40);
  assert.deepEqual(row40.cells.map((c) => [c.text, c.date_guess]), [['46000', undefined], ['#N/A', undefined], ['1', undefined]]);
  // 文字参照と Excel の _xHHHH_ は文字にする
  const refs = calendarWorkbook({ sheets: [{ name: '表', plain: true, items: [{ r: 1, col: 1, text: 'A&#12354;_x3044_B' }] }] });
  const raw = edit(refs, 'xl/sharedStrings.xml', (x) => x.replace('A&amp;#12354;_x3044_B', 'A&#12354;_x3044_B'));
  assert.equal(readSheetRows(raw).rows[0].cells[0].text, 'AあいB');
  assert.equal(readSheetRows(refs).rows[0].cells[0].text, 'A&#12354;いB', '& を escape した文字参照は文字のまま');
});

test('工程表：見出しのすぐ下が予定の行なら曜日と取り違えない・1904 年から数える workbook の日付・予定の中の日付らしい数に引きずられない', async () => {
  const { entryData, makeEntry, readZip, writeZip } = await import('../scripts/lib/xlsx/zip.mjs');
  // 曜日の行を、どの日にも短い予定のある行に書き換える（文字の種類が多い＝曜日ではない）
  const base = calendarWorkbook({ sheets: [{ name: '表', start: '2026-11-10', days: 20, labels: [{ r: 3, a: '第1班', rows: 1 }], items: [{ date: '2026-11-16', r: 3, text: '山田邸', n: 45000 }, { date: '2026-11-17', r: 3, n: 45001 }] }] });
  const edit = (bytes, name, fn) => writeZip(readZip(bytes).map((e) => (e.name === name ? makeEntry(name, Buffer.from(fn(entryData(e).toString('utf8'))), e) : e)));
  const normal = readCalendar(base, { today: TODAY });
  assert.deepEqual([normal.days[0].weekday, normal.days[0].items], ['月', [{ r: 3, label: '第1班', text: '山田邸 45000' }]], '予定の中の 45000（日付らしい数）は数のまま');
  // 2 行目から予定の表（どの日にも短い予定があり、文字の種類が多い＝曜日ではない）
  const busy = calendarWorkbook({ sheets: [{ name: '表', start: '2026-11-10', days: 20, noWeekday: true, items: Array.from({ length: 20 }, (_, i) => ({ date: new Date(Date.parse('2026-11-10T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10), r: 2, text: `現${String.fromCharCode(0x4e00 + i)}` })) }] });
  const b = readCalendar(busy, { today: TODAY });
  assert.equal(b.days[0].weekday, undefined);
  assert.deepEqual(b.days[0].items, [{ r: 2, label: '班', text: `現${String.fromCharCode(0x4e00 + 6)}` }], '2 行目は予定として返す（曜日として落とさない）');
  // 1904 年から数える workbook：同じ数が 1462 日後の日付になる
  const d1904 = edit(base, 'xl/workbook.xml', (x) => x.replace('<sheets>', '<workbookPr date1904="1"/><sheets>'));
  const r = readCalendar(d1904, { today: '2030-11-17' });
  assert.deepEqual(r.range, { from: '2030-11-11', to: '2030-11-30' });
  assert.equal(readSheetRows(d1904).rows[0].cells.find((c) => c.date_guess).date_guess, '2030-11-11');
});

// ─── Task Hub：結果の大きさ ───
test('Task Hub：実の形の工程表の schedule.read が成功する（前は 16 KiB を越えて result_invalid＝想定外）・今日は config の時刻', async () => {
  const w = await world();
  try {
    assert.ok(bytesOf(readSheetRows(bigCalendar(), { maxRows: 30 })) > MAX_BODY_BYTES, '前の読み方（最初の 30 行）は上限を越える形の作り物である');
    const { env, run, submit, res } = hub(w);
    env.clock.t = Date.parse('2026-11-16T16:30:00.000Z'); // 日本の時刻では 11-17 の 01:30
    const ids = { week: await submit('schedule.read', {}), day: await submit('schedule.read', { date: '2026-11-20' }), q: await submit('schedule.read', { query: '山田' }), range: await submit('schedule.read', { from: '2026-09-01', to: '2026-12-31' }) };
    await run();
    for (const [k, id] of Object.entries(ids)) { assert.equal(res(id).state, 'succeeded', `${k}：${res(id).error?.code}`); assert.ok(bytesOf(res(id).result) <= MAX_BODY_BYTES); }
    assert.deepEqual([res(ids.week).result.today, res(ids.week).result.from, res(ids.week).result.days.length], ['2026-11-17', '2026-11-17', 7], '今日＝utc_offset_minutes の時刻');
    assert.equal(res(ids.day).result.days[0].items.length, 10);
    assert.equal(res(ids.q).result.from, '2026-11-17');
    assert.equal(res(ids.range).result.truncated, true);
    assert.equal(env.store.breakerCount(), 0);
  } finally { await w.close(); }
});

test('Task Hub：schedule.read の日付の誤り・日付の無い表への日付の指定は想定内の失敗（PAUSE に数えない）・台帳の形は日付の形だけ通す', async () => {
  const spec = loadCatalog().intents['schedule.read'].params_schema;
  assert.equal(checkSpec(spec, { date: '2026-11-16' }), null);
  assert.equal(checkSpec(spec, { from: '2026-11-16', to: '2026-11-20', query: '山田', sheet: '新', file: 1 }), null);
  assert.ok(checkSpec(spec, { date: '11/16' }));
  assert.ok(checkSpec(spec, { day: '2026-11-16' }));
  const w = await world({ schedule: fixtureWorkbook() }); // 日付の見出しの無い表
  try {
    const { run, submit, res } = hub(w);
    const ids = { bad: await submit('schedule.read', { date: '2026-02-30' }), both: await submit('schedule.read', { date: '2026-11-16', from: '2026-11-16' }), toOnly: await submit('schedule.read', { to: '2026-11-16' }), rev: await submit('schedule.read', { from: '2026-11-20', to: '2026-11-16' }), noCal: await submit('schedule.read', { date: '2026-11-16' }), rows: await submit('schedule.read', {}) };
    const out = await run();
    for (const k of ['bad', 'both', 'toOnly', 'rev']) assert.deepEqual([res(ids[k]).state, res(ids[k]).error.code], ['failed', 'schedule_date_invalid'], k);
    assert.equal(res(ids.noCal).error.code, 'schedule_not_calendar');
    assert.deepEqual([res(ids.rows).state, res(ids.rows).result.mode], ['succeeded', 'rows'], '日付の無い表は前のとおり行で読む');
    assert.equal(out.paused, false);
  } finally { await w.close(); }
});

test('Task Hub：日本語の長い名前が 100 件の一覧・検索・長いカルテでも成功する（bytes で数えて手前で切る・truncated）', async () => {
  const w = await world();
  try {
    const long = (i) => `令和８年度_現場管理資料_足場組立解体工事_作業手順書および安全衛生計画書_第${String(i).padStart(3, '0')}版（最終確認済み・提出用）.xlsx`;
    for (let i = 0; i < 100; i += 1) w.read.put(`/業務/現場管理/山田様邸新築工事（仮称）足場工事一式/${long(i)}`, Buffer.from('x'));
    // 長いカルテ（Human が書き足した 7000 字）
    const karte = `${newKarte({ caseId: 'CASE-0001', siteName: '現場A', fields: {}, at: '2026-11-16T00:00:00.000Z', taskId: 't-0' })}\n${'現地で確認した内容を書き足す。'.repeat(500)}\n`;
    w.write.put('/biz-a/karte/CASE-0001.md', Buffer.from(karte, 'utf8'));
    const { run, submit, res } = hub(w);
    const ids = { list: await submit('dropbox.list', { path: '/業務/現場管理/山田様邸新築工事（仮称）足場工事一式' }), search: await submit('dropbox.search', { query: '現場管理資料', path: '/業務/現場管理' }), karte: await submit('karte.get', { case_id: 'CASE-0001' }), report: await submit('karte.report', { case_id: 'CASE-0001' }), sec: await submit('karte.get', { case_id: 'CASE-0001', section: 'unknowns' }) };
    await run();
    for (const [k, id] of Object.entries(ids)) { assert.equal(res(id).state, 'succeeded', `${k}：${res(id).error?.code}`); assert.ok(bytesOf(res(id).result) <= MAX_BODY_BYTES, `${k} ${bytesOf(res(id).result)}`); }
    const l = res(ids.list).result;
    assert.deepEqual([l.count, l.truncated, l.returned, l.entries.length < 100, l.path], [100, true, l.entries.length, true, '/業務/現場管理/山田様邸新築工事（仮称）足場工事一式'], '依頼の文字は受け口で半角のかっこになるが、実の名前（全角）のフォルダを読む');
    assert.ok(l.entries.every((e) => e.name && e.path === undefined), '一覧は名前だけ（path は結果の path＋名前）');
    assert.equal(res(ids.search).result.truncated, true);
    assert.ok(res(ids.search).result.files.every((f) => f.path.startsWith('/業務/現場管理/')));
    const k = res(ids.karte).result;
    assert.equal(k.truncated, true);
    assert.ok(k.text.endsWith('…(省略)') && k.text.startsWith('# '), '途中まで');
    assert.ok(k.human_chars > 7000, '数は全文から');
    assert.equal(res(ids.sec).result.truncated, true, '長い節も途中まで');
  } finally { await w.close(); }
});

test('結果の部品：clip は字数と bytes の両方で切る（絵文字の途中で切らない）・fitList は上限の手前まで・越えた結果は想定内の result_too_large', async () => {
  assert.equal(clip('短い文'), '短い文');
  const ja = 'あ'.repeat(5000);
  const c = clip(ja);
  assert.ok(bytesOf(c) <= 11_100 && c.endsWith('…(省略)') && [...c].length < 5000, '6000 字の内でも bytes で切る');
  const emoji = '🏗'.repeat(4000);
  const e = clip(emoji).replace('\n…(省略)', '');
  assert.equal(e, '🏗'.repeat([...e].length), 'サロゲートの対の途中で切らない');
  const esc = clip('"\n'.repeat(4000));
  assert.ok(bytesOf(esc) <= 11_100, 'JSON の escape（改行・引用符）も数える');
  const ascii = 'a'.repeat(7000);
  assert.equal([...clip(ascii)].length, 6000 + '\n…(省略)'.length, 'bytes が足りていても 6000 字まで');
  const items = Array.from({ length: 200 }, (_, i) => ({ name: `資料${i}`.padEnd(40, '字') }));
  const f = fitList(items);
  assert.ok(f.kept.length > 0 && f.cut === 200 - f.kept.length && bytesOf(f.kept) <= RESULT_LIST_BYTES);
  assert.deepEqual(fitList([{ a: 1 }]), { kept: [{ a: 1 }], cut: 0 });
  await assert.rejects(bounded(async () => ({ result: { text: 'あ'.repeat(6000) } }))({}), (err) => err.code === 'result_too_large' && err.expected === true);
  assert.deepEqual(await bounded(async () => ({ result: { ok: true } }))({}), { result: { ok: true } });
});

// ─── 範囲：実の名前の形 ───
test('範囲：名前の中の全角の空白・半角のかっこ・全角の＆を読める・同じ名前の「使っていない側」の木と古い予定表は範囲の外', () => {
  const s = loadScopes(DROPBOX).get('biz-a');
  assert.equal(assertReadable(s, '/業務/工\u3000事/現場A/平面図.pdf', 'browse'), '/業務/工\u3000事/現場A/平面図.pdf');
  assert.equal(assertReadable(s, SCHED, 'schedule'), SCHED);
  assert.equal(assertReadable(s, SCHED.normalize('NFD'), 'schedule'), SCHED, 'NFD で貼った path も同じ');
  assert.throws(() => assertReadable(s, '/業務/工事/現場A/平面図.pdf', 'browse'), { code: 'dropbox_path_not_allowed' }, '空白の無い名前は別のフォルダ');
  assert.throws(() => assertReadable(s, '/（株）会社A/年間予定表.xlsx', 'schedule'), { code: 'dropbox_path_not_allowed' }, '全角のかっこは別の名前');
  assert.throws(() => assertReadable(s, '/業務/過去の予定表/年間予定表.xlsx', 'schedule'), { code: 'dropbox_path_not_allowed' }, '同じ名前の古い写しは工程表ではない');
  assert.equal(browsable(s, '/(株)会社A/業務/工\u3000事/現場A/平面図.pdf'), false, '使っていない側の同じ名前の木');
  assert.equal(browsable(s, '/業務/Q＆A/a.pdf'), true);
});

// ─── 全角の名前：依頼の path を実の名前に直す ───
test('全角の名前：受け口が NFKC に揃えた依頼でも、実の名前（全角の空白・＆・かっこ）のフォルダの一覧・検索ができる・結果の path は実の名前', async () => {
  const w = await world();
  try {
    w.read.put('/業務/工\u3000事/山田様邸（仮称）/図面①.pdf', Buffer.from('x'));
    w.read.put('/業務/工\u3000事/Ａ社／Ｂ社\u3000共同/資料.pdf', Buffer.from('x')); // 全角の斜線を含む名前（畳むと 2 部分に割れる）
    const { run, submit, res } = hub(w);
    const ids = {
      moto: await submit('dropbox.list', { path: '/業務/工\u3000事' }), // 受け口で「工 事」（半角の空白）になる
      fm: await submit('dropbox.list', { path: '/業務/Q＆A' }),
      deep: await submit('dropbox.list', { path: '/業務/工\u3000事/山田様邸（仮称）' }),
      slash: await submit('dropbox.list', { path: '/業務/工 事/A社/B社 共同' }),
      search: await submit('dropbox.search', { query: '図面', path: '/業務/工 事/山田様邸(仮称)' }),
      none: await submit('dropbox.list', { path: '/業務/工\u3000事/無い（仮称）' }),
      outside: await submit('dropbox.list', { path: '/（株）会社A/業務/工\u3000事' }),
    };
    assert.equal(res(ids.moto).params.path, '/業務/工 事', '受け口は依頼の文字を NFKC に揃える（全角の空白 → 半角）');
    await run();
    assert.deepEqual([res(ids.moto).state, res(ids.moto).result.path, res(ids.moto).result.entries.map((e) => e.name).sort()], ['succeeded', '/業務/工\u3000事', ['山田様邸（仮称）', '現場A', 'Ａ社／Ｂ社\u3000共同']]);
    assert.deepEqual([res(ids.fm).result.path, res(ids.fm).result.count], ['/業務/Q＆A', 1]);
    assert.deepEqual([res(ids.deep).result.path, res(ids.deep).result.entries[0].name], ['/業務/工\u3000事/山田様邸（仮称）', '図面①.pdf']);
    assert.deepEqual([res(ids.slash).state, res(ids.slash).result.path], ['succeeded', '/業務/工\u3000事/Ａ社／Ｂ社\u3000共同']);
    assert.deepEqual(res(ids.search).result.files.map((f) => f.path), ['/業務/工\u3000事/山田様邸（仮称）/図面①.pdf']);
    assert.deepEqual([res(ids.none).state, res(ids.none).error.code], ['failed', 'dropbox_path_not_found']);
    assert.deepEqual([res(ids.outside).state, res(ids.outside).error.code], ['failed', 'dropbox_path_not_allowed'], '使っていない側の同じ名前の木は範囲の外');
  } finally { await w.close(); }
});

test('全角の名前：直すのは許可フォルダの中だけ・読ませない場所と見積のフォルダは全角半角のちがいでも断る（中の一覧も取らない）・同じに畳まれる名前が 2 つなら決めない', async () => {
  const w = await world();
  try {
    const cfg = { businesses: { 'biz-a': { read_roots: ['/業務'], estimate_roots: ['/業務/見積書の原本'], deny_roots: ['/業務/人事（個人）'], output_root: '/biz-a' } } };
    const s = loadScopes(cfg).get('biz-a');
    w.read.put('/業務/人事（個人）/給与.xlsx', Buffer.from('x'));
    w.read.put('/業務/資料（Ａ）/a.pdf', Buffer.from('x'));
    w.read.put('/業務/資料(A)/b.pdf', Buffer.from('x')); // 畳むと「資料(a)」で同じ
    w.read.put('/業務/別（Ｂ）/c.pdf', Buffer.from('x'));
    assert.deepEqual(matchRoot(s, '/業務/工 事/x', 'browse'), { root: '/業務', rest: ['工 事', 'x'] });
    assert.equal(matchRoot(s, '/他/工 事', 'browse'), null);
    assert.equal(await resolveReal(w.reader, s, '/業務/工 事/現場A', 'browse'), '/業務/工\u3000事/現場A');
    assert.equal(await resolveReal(w.reader, s, '/業務/別(B)/c.pdf', 'browse'), '/業務/別（Ｂ）/c.pdf');
    assert.equal(await resolveReal(w.reader, s, '/業務/資料(A)/b.pdf', 'browse'), '/業務/資料(A)/b.pdf', 'ぴったりの名前が在ればそれ');
    assert.equal(await resolveReal(w.reader, s, '/業務/資料(a)', 'browse'), '/業務/資料(A)', '大文字小文字だけのちがいは Dropbox の名前に');
    await assert.rejects(resolveReal(w.reader, s, '/業務/別(B)/無い/y', 'browse'), { code: 'dropbox_path_not_found' }, '無い物は無い');
    await assert.rejects(resolveReal(w.reader, s, '/業務/資料（a）/x/y', 'browse'), { code: 'dropbox_path_ambiguous' }, 'ぴったりの名前が無く、畳むと同じ名前が 2 つ');
    // 読ませない場所：依頼が半角のかっこでも断る。中の一覧は取らない
    w.read.state.calls.length = 0;
    await assert.rejects(resolveReal(w.reader, s, '/業務/人事(個人)/給与.xlsx', 'browse'), { code: 'dropbox_path_not_allowed' });
    await assert.rejects(resolveReal(w.reader, s, '/業務/見積書の原本/現場A_見積書.xlsx', 'browse'), { code: 'dropbox_path_not_allowed' }, '見積は承認なしの読み方では読めない');
    assert.equal(w.read.state.calls.filter((u) => u.startsWith('/2/')).length, 0, '断る path は Dropbox に聞かない');
    assert.equal(browsable(s, '/業務/人事(個人)/給与.xlsx'), false, '一覧の結果を絞る時も畳んで断る');
    assert.equal(await resolveReal(w.reader, s, '/業務/見積書の原本/現場A_見積書.xlsx', 'estimate'), '/業務/見積書の原本/現場A_見積書.xlsx');
    // 同じに畳まれる名前が 2 つ・ぴったりが無い
    w.read.put('/業務/共有（Ｘ）/d.pdf', Buffer.from('x'));
    w.read.put('/業務/共有（x）/e.pdf', Buffer.from('x'));
    await assert.rejects(resolveReal(w.reader, s, '/業務/共有(x)/d.pdf', 'browse'), { code: 'dropbox_path_ambiguous' }, '受け口が半角にした名前では、全角の 2 つのどちらか決められない');
    assert.equal(await resolveReal(w.reader, s, '/業務/共有（x）/e.pdf', 'browse'), '/業務/共有（x）/e.pdf', '実の名前のとおりなら（受け口を通らない呼び方）そのまま');
    await assert.rejects(resolveReal(w.reader, s, '/業務/../秘密', 'browse'), { code: 'dropbox_path_invalid' });
  } finally { await w.close(); }
});

test('全角の名前：見積の原本（全角のかっこの file 名）から AI 作業版を作り、受け口が半角にした名前で直せる・工程表の sheet 名も畳んで選ぶ', async () => {
  const w = await world({ schedule: calendarWorkbook({ sheets: [{ name: '工程２０２６（３）', start: '2026-11-10', days: 20, labels: [{ r: 3, a: '第1班' }], items: [{ date: '2026-11-16', r: 3, text: '山田邸' }] }] }) });
  try {
    const real = '/業務/見積書の原本/見積書（山田様邸）.xlsx';
    w.read.put(real, fixtureWorkbook());
    const { run, res, approved, submit } = hub(w);
    const rows = [{ item: '足場', qty: 100, unit: 'm2', price: 1000 }];
    const c = await approved('estimate.ai.create', { original_path: real, sheet_name: 'AI_案1', title: '案1', rows });
    assert.equal(res(c).params.original_path, '/業務/見積書の原本/見積書(山田様邸).xlsx', '受け口で半角のかっこになる');
    const sh = await submit('schedule.read', { sheet: '工程２０２６（３）', date: '2026-11-16' });
    await run();
    assert.equal(res(c).state, 'succeeded', res(c).error?.code);
    const name = workingName(real);
    assert.equal(res(c).result.path, `/biz-a/estimates/${name}`, 'AI 作業版の名前は実の原本の名前から');
    assert.ok(name.includes('（山田様邸）'));
    const e = await approved('estimate.ai.edit', { working_name: name, sheet_name: 'AI_案1', title: '案1 改', rows: [{ item: '足場', qty: 120, unit: 'm2', price: 1000 }] });
    assert.notEqual(res(e).params.working_name, name, '受け口で半角になる');
    await run();
    assert.deepEqual([res(e).state, res(e).result.diff.total_before, res(e).result.diff.total_after], ['succeeded', 100000, 120000]);
    assert.deepEqual([res(sh).state, res(sh).result.sheet, res(sh).result.days[0].items[0].text], ['succeeded', '工程２０２６（３）', '山田邸']);
  } finally { await w.close(); }
});

test('全角の名前（監査）：畳むと同じ名前の許可フォルダが 2 つ・ぴったりの名前が先・一覧が上限で切れた時・点つきの I は決めない／拒否する', async () => {
  const w = await world();
  try {
    // 見積の原本のフォルダ：半角の斜線の「/見積/2026」と、全角の斜線の名前「見積／2026」の両方が許可フォルダ
    const est = loadScopes({ businesses: { 'biz-a': { estimate_roots: ['/見積', '/見積／2026'], output_root: '/biz-a' } } }).get('biz-a');
    w.read.put('/見積/2026/山田.xlsx', fixtureWorkbook());
    w.read.put('/見積／2026/山田.xlsx', fixtureWorkbook());
    assert.equal(await resolveReal(w.reader, est, '/見積/2026/山田.xlsx', 'estimate'), '/見積/2026/山田.xlsx', '依頼の文字のままの許可フォルダが先（承認した file と違う file を読まない）');
    // 畳むと同じ名前の 2 つの許可フォルダ（どちらも依頼の文字とは違う）：決めない
    const two = loadScopes({ businesses: { 'biz-a': { read_roots: ['/業務/共有（Ｘ）', '/業務/共有（x）'], output_root: '/biz-a' } } }).get('biz-a');
    w.read.put('/業務/共有（Ｘ）/d.pdf', Buffer.from('x'));
    w.read.put('/業務/共有（x）/d.pdf', Buffer.from('x'));
    assert.deepEqual(matchRoot(two, '/業務/共有(x)/d.pdf', 'browse'), { ambiguous: true });
    await assert.rejects(resolveReal(w.reader, two, '/業務/共有(x)/d.pdf', 'browse'), { code: 'dropbox_path_ambiguous' });
    assert.equal(await resolveReal(w.reader, two, '/業務/共有（x）/d.pdf', 'browse'), '/業務/共有（x）/d.pdf');
    // 深い許可フォルダと浅い許可フォルダ（入れ子）は深い方
    const nest = loadScopes({ businesses: { 'biz-a': { read_roots: ['/業務/工\u3000事', '/業務/工\u3000事/現場A'], output_root: '/biz-a' } } }).get('biz-a');
    assert.deepEqual(matchRoot(nest, '/業務/工 事/現場A/平面図.pdf', 'browse'), { root: '/業務/工\u3000事/現場A', rest: ['平面図.pdf'] });
    // 一覧が上限（2000 件）で切れている：ぴったりの名前は一覧に頼らずに見つかる・畳んで探す名前は「他に無い」と言えないので決めない
    const wide = loadScopes({ businesses: { 'biz-a': { read_roots: ['/広い'], output_root: '/biz-a' } } }).get('biz-a');
    w.read.put('/広い/資料（Ａ）/sub/y.pdf', Buffer.from('x'));
    w.read.put('/広い/別（Ｃ）/c.pdf', Buffer.from('x'));
    for (let i = 0; i < 2005; i += 1) w.read.put(`/広い/z${String(i).padStart(4, '0')}/f`, Buffer.from('x'));
    w.read.put('/広い/資料(A)/sub/ｙ.pdf', Buffer.from('x'));
    assert.equal(await resolveReal(w.reader, wide, '/広い/資料(A)/sub/y.pdf', 'browse'), '/広い/資料(A)/sub/ｙ.pdf', 'ぴったりの名前のフォルダを先に下りる（一覧の順に左右されない）');
    await assert.rejects(resolveReal(w.reader, wide, '/広い/資料(Ａ)x/sub/y.pdf', 'browse'), { code: 'dropbox_path_not_found' });
    await assert.rejects(resolveReal(w.reader, wide, '/広い/別(C)/c.pdf', 'browse'), { code: 'dropbox_path_ambiguous' }, '切れた一覧の中に 1 つ見えても、見えていない所に同じ名前が無いとは言えない＝決めない');
    w.read.put('/広い/後（Ｄ）/d.pdf', Buffer.from('x'));
    await assert.rejects(resolveReal(w.reader, wide, '/広い/後(D)/d.pdf', 'browse'), { code: 'dropbox_path_not_found' }, '一覧の上限より後ろの全角の名前は見つからない（止まる側）');
    // 小文字にすると長さが変わる文字（点つきの大文字 I）を含む path は扱わない
    assert.throws(() => loadScopes({ businesses: { 'biz-a': { read_roots: ['/業務/\u0130'], output_root: '/biz-a' } } }), { code: 'dropbox_config_invalid' });
    await assert.rejects(resolveReal(w.reader, wide, '/広い/\u0130/x', 'browse'), { code: 'dropbox_path_invalid' });
    // 断る側は前からの比べ方（小文字）でも断る（畳むと別の文字になる大文字小文字の組）
    const sig = loadScopes({ businesses: { 'biz-a': { read_roots: ['/業務'], deny_roots: ['/業務/\u03f9秘'], output_root: '/biz-a' } } }).get('biz-a');
    assert.equal(browsable(sig, '/業務/\u03f2秘/a'), false);
    assert.throws(() => assertReadable(sig, '/業務/\u03f2秘/a', 'any'), { code: 'dropbox_path_not_allowed' });
  } finally { await w.close(); }
});

test('結果の大きさ（監査）：書く handler は書いた後に失敗と言わない（tab の多いブックでも成功）・検索は上限の件数に達したら truncated・同じに畳まれる AI 作業版が 2 つなら直さない', async () => {
  const w = await world();
  try {
    // tab が 102 枚・名前が 31 字の見積
    const { entryData, makeEntry, readZip, writeZip } = await import('../scripts/lib/xlsx/zip.mjs');
    const many = (() => {
      const base = readZip(fixtureWorkbook());
      const name = (i) => `${'見積の内訳の長い名前のタブ'.repeat(3).slice(0, 27)}${String(i).padStart(3, '0')}`;
      const extra = Array.from({ length: 100 }, (_, i) => i + 3);
      const map = (e) => {
        const t = entryData(e).toString('utf8');
        if (e.name === 'xl/workbook.xml') return makeEntry(e.name, Buffer.from(t.replace('</sheets>', `${extra.map((i) => `<sheet name="${name(i)}" sheetId="${i}" r:id="rIdX${i}"/>`).join('')}</sheets>`)), e);
        if (e.name === 'xl/_rels/workbook.xml.rels') return makeEntry(e.name, Buffer.from(t.replace('</Relationships>', `${extra.map((i) => `<Relationship Id="rIdX${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>`).join('')}</Relationships>`)), e);
        return e;
      };
      return writeZip(base.map(map));
    })();
    w.read.put('/業務/見積書の原本/大きい見積.xlsx', many);
    for (let i = 0; i < 40; i += 1) w.read.put(`/業務/現場管理/検索の確かめ_${i}.pdf`, Buffer.from('x'));
    const { run, res, approved, submit } = hub(w);
    const rows = [{ item: '足場', qty: 100, unit: 'm2', price: 1000 }];
    const c = await approved('estimate.ai.create', { original_path: '/業務/見積書の原本/大きい見積.xlsx', sheet_name: 'AI_案1', title: '案1', rows });
    const se = await submit('dropbox.search', { query: '検索の確かめ', path: '/業務/現場管理' });
    const few = await submit('dropbox.search', { query: '工程写真', path: '/業務/現場管理' });
    await run();
    assert.equal(res(c).state, 'succeeded', res(c).error?.code);
    assert.ok(bytesOf(res(c).result) <= MAX_BODY_BYTES);
    assert.deepEqual([res(c).result.diff.sheets_count, res(c).result.diff.sheets_before.length, res(c).result.diff.sheets_after.at(-1)], [103, 40, 'AI_案1'], 'tab の名前は 40 まで・数は全部');
    assert.equal(w.write.files.size, 1, '書いたのは 1 回');
    assert.deepEqual([res(se).result.count, res(se).result.truncated], [30, true], '上限の 30 件に達した＝もっと在るかもしれない');
    assert.deepEqual([res(few).result.count, res(few).result.truncated], [1, undefined], '上限に届かなければ「これで全部」');
    // 書く handler の結果が越えた時は、小さな値だけ残して成功を返す（読む handler は result_too_large）
    const out = await bounded(async () => ({ result: { created: true, path: '/biz-a/estimates/a.xlsx', rev: '01', big: { names: Array.from({ length: 2000 }, (_, i) => `名前${i}`) }, note: 'あ'.repeat(6000) } }), { writes: true })({});
    assert.deepEqual(out.result, { created: true, path: '/biz-a/estimates/a.xlsx', rev: '01', result_trimmed: true });
    // 台帳に、畳むと同じ名前の AI 作業版が 2 つ：受け口が半角にした名前では決めない
    const real = '/業務/見積書の原本/見積書（Ａ）.xlsx';
    const other = '/業務/見積書の原本/見積書（a）.xlsx';
    w.read.put(real, fixtureWorkbook());
    w.read.put(other, fixtureWorkbook());
    // 2 つの原本は名前が違う＝AI 作業版の名前（原本の path の hash つき）も違うが、hash を除いた形をそろえて台帳に置く
    const ledgerFile = path.join(w.dir, 'biz-a', 'estimates', 'ledger.json');
    const fs = await import('node:fs');
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    const key = Object.keys(ledger.copies)[0];
    ledger.copies['/biz-a/estimates/写し（Ａ）.xlsx'] = { ...ledger.copies[key], tasks: [] };
    ledger.copies['/biz-a/estimates/写し（ａ）.xlsx'] = { ...ledger.copies[key], tasks: [] };
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
    const e = await approved('estimate.ai.edit', { working_name: '写し（Ａ）.xlsx', sheet_name: 'AI_案1', title: '案1', rows });
    await run();
    assert.deepEqual([res(e).state, res(e).error.code], ['failed', 'estimate_copy_ambiguous']);
  } finally { await w.close(); }
});

// ─── 設定の照らし（dropbox-preflight）───
test('preflight：正しい設定は ok（同じ名前の予定表が別の場所に在ることは warning で知らせる）・書きの app は App folder', async () => {
  const w = await world();
  try {
    const r = await preflight({ dropbox: DROPBOX, reader: w.reader, writer: w.writer, deep: true, today: TODAY });
    assert.deepEqual([r.code, r.problems, r.warnings], ['warning', 0, 1]);
    const sched = r.items.find((x) => x.key === 'schedule_files');
    assert.deepEqual([sched.status, sched.code, sched.twins, sched.twins_newer], ['warning', 'same_name_elsewhere', 1, 1]);
    assert.deepEqual(sched.twin_paths, ['/業務/過去の予定表/年間予定表.xlsx']);
    assert.deepEqual(sched.deep, { sheets: 2, mode: 'calendar', from: '2026-05-01', to: '2027-01-15' });
    assert.equal(r.items.find((x) => x.key === 'write_app').status, 'ok');
    assert.ok(r.items.filter((x) => x.key !== 'schedule_files').every((x) => x.status === 'ok'));
    // 画面の行：既定では path を出さない（log に会社の名前を残さない）
    const line = describe(sched);
    assert.ok(!line.includes('予定表') && !line.includes('会社A') && line.includes('same_name_elsewhere'), line);
    assert.ok(describe(sched, true).includes(SCHED));
    assert.equal(w.read.state.calls.some((u) => u === '/2/files/upload'), false);
    assert.equal(w.write.state.calls.some((u) => u === '/2/files/upload'), false, '書かない');
  } finally { await w.close(); }
});

test('preflight：人が読んだ名前のずれ（全角のかっこ・空白の無い名前）は problem＝どの部分から無いか・似た名前が在るか・Dropbox の名前', async () => {
  const w = await world();
  try {
    const typed = { businesses: { 'biz-a': { read_roots: ['/業務/工事', '/業務/現場管理/無いフォルダ', SCHED], schedule_files: ['/（株）会社A/年間予定表.xlsx', '/業務/現場管理'], estimate_roots: ['/業務/見積書の原本/現場A_見積書.xlsx'], output_root: '/biz-a' } } };
    const r = await preflight({ dropbox: typed, reader: w.reader, today: TODAY });
    assert.equal(r.code, 'problem');
    const by = (key, n) => r.items.find((x) => x.key === key && x.n === n);
    assert.deepEqual([by('read_roots', 1).code, by('read_roots', 1).broken_at, by('read_roots', 1).similar, by('read_roots', 1).suggestion], ['not_found', 2, 1, '/業務/工\u3000事']);
    assert.deepEqual([by('read_roots', 2).code, by('read_roots', 2).broken_at, by('read_roots', 2).similar], ['not_found', 3, 0]);
    assert.equal(by('read_roots', 3).code, 'not_folder', 'file を読むフォルダに書いた');
    assert.deepEqual([by('schedule_files', 1).code, by('schedule_files', 1).broken_at, by('schedule_files', 1).suggestion], ['not_found', 1, '/(株)会社A/年間予定表.xlsx']);
    assert.equal(by('schedule_files', 2).code, 'not_file');
    assert.equal(by('estimate_roots', 1).code, 'not_folder');
    assert.equal(r.problems, 6);
    // 既定の行には path・Dropbox の名前のどの部分も出ない
    for (const it of r.items) for (const part of [...(it.path ?? '').split('/'), ...(it.suggestion ?? '').split('/')].filter(Boolean)) assert.ok(!describe(it).includes(part), `${it.key}[${it.n}] の行に名前「${part}」が出ている`);
    assert.ok(describe(by('read_roots', 1)).includes('似た名前あり') && describe(by('read_roots', 1), true).includes(by('read_roots', 1).suggestion));
    // 大文字小文字だけのちがいは動く（warning で Dropbox の名前を返す）
    const cased = await preflight({ dropbox: { businesses: { 'biz-a': { read_roots: ['/業務/q＆a'], output_root: '/biz-a' } } }, reader: w.reader, today: TODAY });
    assert.deepEqual([cased.code, cased.items[0].code, cased.items[0].suggestion], ['warning', 'spelled_differently', '/業務/Q＆A']);
    assert.equal(foldName('工\u3000事'), foldName('工事'));
    assert.equal(foldName('（株）会社Ａ'), foldName('(株)会社a'));
  } finally { await w.close(); }
});

test('preflight：設定が無い・読めない・書きの app が Dropbox 全体を見ている・CLI は資格情報なしで止まる（Keychain を読まない store）', async () => {
  const w = await world();
  try {
    assert.equal((await preflight({ dropbox: undefined, reader: w.reader })).code, 'not_configured');
    assert.equal((await preflight({ dropbox: { businesses: { 'biz-a': { read_roots: ['相対'], output_root: '/biz-a' } } }, reader: w.reader })).code, 'config_invalid');
    // 書きの資格情報が読みと同じ名前空間を見ている＝App folder の app ではない
    const full = await preflight({ dropbox: DROPBOX, reader: w.reader, writer: w.reader, today: TODAY });
    assert.deepEqual([full.code, full.items.find((x) => x.key === 'write_app').code], ['problem', 'write_app_not_app_folder']);
    const dir = mkdtempSync(path.join(tmpdir(), 'dbx-pre-'));
    const r = spawnSync(process.execPath, ['scripts/dropbox-preflight.mjs', '--store', dir], { encoding: 'utf8', timeout: 20_000 });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /"code":"config_unreadable"/);
  } finally { await w.close(); }
});
