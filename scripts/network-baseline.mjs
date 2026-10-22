#!/usr/bin/env node
/**
 * Mac mini（Runtime Node）のネットワークの基準値と比較（2026-10-22・Vault MA-22 S8・Mac Runtime）。READ-ONLY・sudo 不要・
 * ネットワークに出ない・macOS のみ。
 *
 *   node scripts/network-baseline.mjs snapshot --out <abs.json>
 *   node scripts/network-baseline.mjs compare --before <abs.json> [--after <abs.json>] [--expect tailscale[,remote-login]] [--json]
 *
 * 目的：共通資源（経路・DNS・VPN・待ち受け）を変える作業（Tailscale の導入・接続、リモートログイン等）の前に基準を取り、
 *   後で比べて「想定どおりの変化」と「想定外の変化（同じホストの VM の通信に波及し得る）」を分ける。判定するだけで、何も戻さない。
 * 取るもの：既定経路の interface（IPv4・IPv6）、静的・接続経路（ARP・近隣の host 経路を除く）の宛先と interface、
 *   resolver（既定・domain 別・scoped）の nameserver と search domain、interface 名、VPN 設定の数、system extension の種類別の数、
 *   loopback 以外の TCP 待ち受け（範囲と port だけ）、proxy の有効フラグ。process・VM・Trading Lab の領域は見ない。
 * 記録：--out のファイル（mode 600・上書きしない）。IP が入るので repo に置かない。画面には IP を出さない（Tailscale の固定範囲だけ出す）。
 * --expect tailscale：新しい utun・その utun 経由の 100.64.0.0/10・fd7a:115c:a1e0::/48 宛ての経路と utun の scoped default・
 *   tailnet 上の待ち受け・VPN 設定と network extension の追加は「想定どおり」。既定経路の interface・既定の resolver・search domain・
 *   ほかの経路・全 interface の待ち受け・proxy の変化と、resolver への 100.100.100.100 の追加（--accept-dns=false の方針に反する）は「想定外」。
 * --expect remote-login：全 interface の :22 の待ち受けを「想定どおり」にする（リモートログインを入れる作業の時だけ）。
 * exit：0＝想定外なし（snapshot は保存できた）／4＝想定外あり／1＝失敗／2＝引数・macOS 以外
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRunner, TRADING_LAB_PATH } from './host-health.mjs';

export const SCHEMA = 'network-baseline/v1';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ALLOWED_BINS = Object.freeze(['/sbin/route', '/usr/sbin/netstat', '/usr/sbin/scutil', '/sbin/ifconfig', '/usr/bin/systemextensionsctl']);
export const PROFILES = Object.freeze(['tailscale', 'remote-login']);
const TAILSCALE_DNS = new Set(['100.100.100.100', 'fd7a:115c:a1e0::53']);

// ─── 出力の読み取り（macOS の表示形式。fixture は 2026-10-22 の Mac mini の実出力を文書用アドレスへ置換したもの）───

export function parseDefaultInterface({ code, stdout }) {
  const m = /^\s*interface:\s*(\S+)/m.exec(stdout ?? '');
  return code === 0 && m ? m[1] : null;
}

/** netstat -rn：W（clone）・L（link-layer）の host 経路は数が揺れるので除く。key は「宛先 interface」、I（interface scoped）は印を付ける */
export function parseRouteTable(stdout) {
  const keys = new Set();
  let inTable = false;
  for (const line of String(stdout).split('\n')) {
    if (/^Destination\s+Gateway\s+Flags/.test(line)) { inTable = true; continue; }
    if (!inTable || !line.trim()) continue;
    const [dest, , flags, netif] = line.trim().split(/\s+/);
    if (!dest || !flags || !netif || /[WL]/.test(flags)) continue;
    keys.add(`${dest} ${netif}${flags.includes('I') ? ' scoped' : ''}`);
  }
  return [...keys].sort();
}

/** scutil --dns：「DNS configuration」と「(for scoped queries)」の 2 節。resolver ごとに domain・nameserver・search・interface */
export function parseDns(stdout) {
  const out = { main: [], scoped: [] };
  let section = null;
  let cur = null;
  for (const line of String(stdout).split('\n')) {
    if (/^DNS configuration \(for scoped queries\)/.test(line)) { section = 'scoped'; cur = null; continue; }
    if (/^DNS configuration/.test(line)) { section = 'main'; cur = null; continue; }
    if (!section) continue;
    if (/^resolver #\d+/.test(line)) { cur = { domain: null, nameservers: [], search: [], if: null }; out[section].push(cur); continue; }
    if (!cur) continue;
    let m;
    if ((m = /^\s+domain\s+:\s+(\S+)/.exec(line))) cur.domain = m[1];
    else if ((m = /^\s+nameserver\[\d+\]\s+:\s+(\S+)/.exec(line))) cur.nameservers.push(m[1]);
    else if ((m = /^\s+search domain\[\d+\]\s+:\s+(\S+)/.exec(line))) cur.search.push(m[1]);
    else if ((m = /^\s+if_index\s+:\s+\d+\s+\((\S+)\)/.exec(line))) cur.if = m[1];
  }
  return out;
}

export function parseInterfaces(stdout) {
  return String(stdout).trim().split(/\s+/).filter(Boolean).sort();
}

/** scutil --nc list：1 行目は見出し、以降 1 行 1 設定 */
export function parseVpnServices(stdout) {
  return String(stdout).split('\n').slice(1).filter((l) => l.trim()).length;
}

/** systemextensionsctl list：「--- com.apple.system_extension.<種類>」の節ごとに、enabled・active の列で始まる行を数える */
export function parseSystemExtensions(stdout) {
  const counts = {};
  let cat = null;
  for (const line of String(stdout).split('\n')) {
    const h = /^--- com\.apple\.system_extension\.(\S+)/.exec(line);
    if (h) { cat = h[1]; counts[cat] = counts[cat] ?? 0; continue; }
    if (cat && /^[*\s]\t[*\s]\t\S+\t/.test(line)) counts[cat] += 1;
  }
  return counts;
}

function inTailnet(addr) {
  const v4 = /^(\d+)\.(\d+)\./.exec(addr);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return /^fd7a:115c:a1e0:/i.test(addr);
}

/** netstat -an -p tcp の LISTEN。loopback は除き、address は範囲（all／tailnet／address）にまとめる */
export function parseListeners(stdout) {
  const set = new Set();
  for (const line of String(stdout).split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6 || cols[5] !== 'LISTEN') continue;
    const local = cols[3];
    const i = local.lastIndexOf('.');
    const addr = local.slice(0, i);
    const port = Number(local.slice(i + 1));
    if (!Number.isInteger(port) || /^127\./.test(addr) || addr === '::1') continue;
    set.add(`${addr === '*' ? 'all' : inTailnet(addr) ? 'tailnet' : 'address'}:${port}`);
  }
  return [...set].sort();
}

export function parseProxy(stdout) {
  const out = {};
  for (const m of String(stdout).matchAll(/^\s+(\w+Enable)\s*:\s*(\d+)/gm)) out[m[1]] = Number(m[2]);
  return out;
}

// ─── 取得 ───

export async function snapshot({ run, now = () => new Date() }) {
  const r = async (bin, args) => run(bin, args);
  const must = async (bin, args) => {
    const x = await r(bin, args);
    if (x.timedOut || x.code !== 0) throw new Error(`${path.basename(bin)} failed`);
    return x.stdout;
  };
  const dns = parseDns(await must('/usr/sbin/scutil', ['--dns']));
  const def = dns.main.find((x) => !x.domain) ?? { nameservers: [], search: [] };
  return {
    schema: SCHEMA,
    taken_at: now().toISOString(),
    default_route: {
      inet: parseDefaultInterface(await r('/sbin/route', ['-n', 'get', 'default'])),
      inet6: parseDefaultInterface(await r('/sbin/route', ['-n', 'get', '-inet6', 'default'])),
    },
    routes: {
      inet: parseRouteTable(await must('/usr/sbin/netstat', ['-rn', '-f', 'inet'])),
      inet6: parseRouteTable(await must('/usr/sbin/netstat', ['-rn', '-f', 'inet6'])),
    },
    dns: {
      default: { nameservers: def.nameservers, search: def.search },
      resolvers: dns.main.filter((x) => x.domain).map(({ domain, nameservers }) => ({ domain, nameservers })),
      scoped: dns.scoped.map(({ if: ifName, nameservers, search }) => ({ if: ifName, nameservers, search })),
    },
    interfaces: parseInterfaces(await must('/sbin/ifconfig', ['-l'])),
    vpn_services: parseVpnServices(await must('/usr/sbin/scutil', ['--nc', 'list'])),
    system_extensions: parseSystemExtensions((await r('/usr/bin/systemextensionsctl', ['list'])).stdout ?? ''),
    listeners: parseListeners(await must('/usr/sbin/netstat', ['-an', '-p', 'tcp'])),
    proxy: parseProxy(await must('/usr/sbin/scutil', ['--proxy'])),
  };
}

// ─── 比較 ───

/** 画面用：IPv4 は上 2 つ、IPv6 は上 2 group だけ残す。Tailscale の固定範囲と default はそのまま */
export function mask(s) {
  return String(s).replace(/\b(\d{1,3}\.\d{1,3})(?:\.\d{1,3}){1,2}\b/g, (all, head) => (inTailnet(all) || all === '100.100.100.100' ? all : `${head}.x.x`))
    .replace(/\b([0-9a-f]{1,4}:[0-9a-f]{1,4}):[0-9a-f:]*(?=[\s/%]|$)/gi, (all, head) => (/^fd7a:115c:a1e0:/i.test(all) ? all : `${head}:…`));
}

const diffSets = (a = [], b = []) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function tailscaleRoute(key, newUtuns) {
  const [dest, netif, scoped] = key.split(' ');
  if (!newUtuns.includes(netif)) return false;
  // 新しい utun の interface scoped の経路（scoped default・link-local・multicast。既存の utun にも同じ組がある）は既定経路を変えない
  if (scoped === 'scoped') return true;
  if (dest === 'default') return false; // scoped でない default は exit node（使わない方針）
  return inTailnet(dest.replace(/\/\d+$/, '')) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])(\/|$)/.test(dest) || /^fd7a:115c:a1e0(::|:)/i.test(dest);
}

/** resolver の表示名：domain は上 2 つのラベルだけ（tailnet 名・ISP の名前を画面に出さない）。domain が無ければ interface */
function label(r) {
  if (r.domain) { const parts = r.domain.split('.'); return parts.length > 2 ? `*.${parts.slice(-2).join('.')}` : r.domain; }
  return r.if ?? 'resolver';
}

/** before／after の snapshot を比べ、変化ごとに expected／unexpected を付ける */
export function compare(before, after, expect = []) {
  const ts = expect.includes('tailscale');
  const rl = expect.includes('remote-login');
  const changes = [];
  const add = (item, expected, detail) => changes.push({ item, kind: expected ? 'expected' : 'unexpected', detail: mask(detail) });

  for (const fam of ['inet', 'inet6']) {
    if (before.default_route?.[fam] !== after.default_route?.[fam]) add(`default_route.${fam}`, false, `${before.default_route?.[fam] ?? 'none'} → ${after.default_route?.[fam] ?? 'none'}`);
  }
  const ifs = diffSets(before.interfaces, after.interfaces);
  const newUtuns = ifs.added.filter((x) => /^utun\d+$/.test(x));
  for (const x of ifs.added) add('interfaces', ts && newUtuns.includes(x), `+ ${x}`);
  for (const x of ifs.removed) add('interfaces', false, `- ${x}`);
  for (const fam of ['inet', 'inet6']) {
    const d = diffSets(before.routes?.[fam], after.routes?.[fam]);
    for (const x of d.added) add(`routes.${fam}`, ts && tailscaleRoute(x, newUtuns), `+ ${x}`);
    for (const x of d.removed) add(`routes.${fam}`, false, `- ${x}`);
  }
  if (!same(before.dns?.default?.nameservers, after.dns?.default?.nameservers)) add('dns.default.nameservers', false, `${before.dns?.default?.nameservers?.length ?? 0} → ${after.dns?.default?.nameservers?.length ?? 0} entries (values not shown)`);
  if (!same(before.dns?.default?.search, after.dns?.default?.search)) add('dns.default.search', false, 'search domains changed (values not shown)');
  for (const kind of ['resolvers', 'scoped']) {
    const key = (x) => JSON.stringify(x);
    const b = (before.dns?.[kind] ?? []).map(key);
    const a = (after.dns?.[kind] ?? []).map(key);
    for (const x of a.filter((k) => !b.includes(k))) {
      const r = JSON.parse(x);
      const tsDns = r.nameservers.some((n) => TAILSCALE_DNS.has(n));
      add(`dns.${kind}`, false, `+ ${label(r)}${tsDns ? '（Tailscale の DNS＝--accept-dns=false の方針に反する）' : ''}`);
    }
    for (const x of b.filter((k) => !a.includes(k))) add(`dns.${kind}`, false, `- ${label(JSON.parse(x))}`);
  }
  if ((after.vpn_services ?? 0) !== (before.vpn_services ?? 0)) add('vpn_services', ts && after.vpn_services > before.vpn_services, `${before.vpn_services} → ${after.vpn_services}`);
  for (const cat of new Set([...Object.keys(before.system_extensions ?? {}), ...Object.keys(after.system_extensions ?? {})])) {
    const b = before.system_extensions?.[cat] ?? 0;
    const a = after.system_extensions?.[cat] ?? 0;
    if (a !== b) add(`system_extensions.${cat}`, ts && cat === 'network_extension' && a > b, `${b} → ${a}`);
  }
  const ls = diffSets(before.listeners, after.listeners);
  for (const x of ls.added) add('listeners', (ts && x.startsWith('tailnet:')) || (rl && x === 'all:22'), `+ ${x}`);
  for (const x of ls.removed) add('listeners', false, `- ${x}`);
  if (!same(before.proxy, after.proxy)) add('proxy', false, `${JSON.stringify(before.proxy)} → ${JSON.stringify(after.proxy)}`);
  return { unexpected: changes.filter((c) => c.kind === 'unexpected').length, expected: changes.filter((c) => c.kind === 'expected').length, changes };
}

// ─── CLI ───

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const a = { cmd, json: false, expect: [] };
  const map = { '--out': 'out', '--before': 'before', '--after': 'after' };
  for (let i = 0; i < rest.length; i += 1) {
    const k = rest[i];
    if (k === '--json') { a.json = true; continue; }
    if (i + 1 >= rest.length) throw new Error(`${k} needs a value`);
    if (k === '--expect') a.expect = rest[i + 1].split(',').filter(Boolean);
    else if (map[k]) a[map[k]] = rest[i + 1];
    else throw new Error(`unknown argument: ${k}`);
    i += 1;
  }
  return a;
}

export function validateArgs(a, { repoRoot = REPO } = {}) {
  const errors = [];
  if (!['snapshot', 'compare'].includes(a.cmd)) errors.push('usage: network-baseline.mjs snapshot --out <abs.json> | compare --before <abs.json> [--after <abs.json>] [--expect tailscale[,remote-login]]');
  if (a.cmd === 'snapshot' && !a.out) errors.push('snapshot needs --out <abs.json>（IP が入るので画面に出さない）');
  if (a.cmd === 'compare' && !a.before) errors.push('compare needs --before <abs.json>');
  for (const k of ['out', 'before', 'after']) {
    if (a[k] === undefined) continue;
    if (!path.posix.isAbsolute(a[k])) errors.push(`--${k} must be an absolute path`);
    else if (TRADING_LAB_PATH.test(a[k])) errors.push(`--${k}: Trading Lab の領域には置かない・読まない`);
  }
  // 基準値には IP が入る。この repo は public なので、repo の中には保存しない（git add の事故を防ぐ）
  if (a.out && path.posix.isAbsolute(a.out) && `${path.resolve(a.out)}/`.startsWith(`${repoRoot}/`)) errors.push('--out must be outside the repository（IP が入るので repo に置かない）');
  if (a.out && existsSync(a.out)) errors.push('--out already exists（基準値は上書きしない。別の名前にする）');
  for (const p of a.expect) if (!PROFILES.includes(p)) errors.push(`--expect must be ${PROFILES.join('|')}`);
  return errors;
}

function readSnapshot(file) {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  if (s?.schema !== SCHEMA) throw new Error(`${path.basename(file)}: not a ${SCHEMA} file`);
  return s;
}

async function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  const errors = validateArgs(a);
  if (errors.length) { console.error(errors.join('\n')); return 2; }
  if (process.platform !== 'darwin') { console.error('network-baseline is for the Mac mini (macOS) only'); return 2; }
  const run = makeRunner({ allowed: ALLOWED_BINS });
  try {
    if (a.cmd === 'snapshot') {
      const s = await snapshot({ run });
      writeFileSync(a.out, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      console.log(JSON.stringify({ component: 'edl-network-baseline', status: 'saved', taken_at: s.taken_at, default_route: s.default_route, routes: { inet: s.routes.inet.length, inet6: s.routes.inet6.length }, resolvers: s.dns.resolvers.length + 1, interfaces: s.interfaces.length, vpn_services: s.vpn_services, listeners: s.listeners }));
      return 0;
    }
    const before = readSnapshot(a.before);
    const after = a.after ? readSnapshot(a.after) : await snapshot({ run });
    const r = compare(before, after, a.expect);
    console.log(JSON.stringify({ component: 'edl-network-baseline', status: r.unexpected ? 'unexpected_changes' : 'ok', expect: a.expect, before: before.taken_at, after: after.taken_at, expected: r.expected, unexpected: r.unexpected, ...(a.json || r.changes.length ? { changes: r.changes } : {}) }, null, 2));
    return r.unexpected ? 4 : 0;
  } catch (err) {
    console.error(JSON.stringify({ component: 'edl-network-baseline', status: 'failed', error: String(err?.message ?? err) }));
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
