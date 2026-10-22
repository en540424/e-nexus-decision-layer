/**
 * Mac mini のネットワークの基準値と比較（2026-10-22・MA-22 S8）。READ-ONLY・許可したコマンドだけ・上書きしない・
 * 画面に IP を出さない・Tailscale の想定どおりの変化と想定外の変化を分ける。コマンドは実行せず fixture で差し替える（Windows でも通る）。
 * fixture は macOS の出力の形を参考にした合成（アドレスは文書用の 192.0.2.0/24・198.51.100.0/24・2001:db8::/32、port・driver・版は例）。
 * Tailscale 接続後の出力は公式 docs（macOS は 100.64/10 を 1 本・fd7a:115c:a1e0::/48）と既存の utun の経路の組から合成。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ALLOWED_BINS, snapshot, compare, mask, parseRouteTable, parseDns, parseListeners, parseSystemExtensions, parseVpnServices, parseProxy,
  parseDefaultInterface, parseArgs, validateArgs,
} from '../scripts/network-baseline.mjs';
import { makeRunner } from '../scripts/host-health.mjs';

const ROUTES4 = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            192.0.2.1          UGScg                 en1
default            link#29            UCSIg           bridge100      !
198.51.100/24      link#29            UC              bridge100      !
127                127.0.0.1          UCS                   lo0
127.0.0.1          127.0.0.1          UH                    lo0
169.254.0.1        02:00:00:00:00:03  UHLSW                 en1      !
192.0.2            link#16            UCS                   en1      !
192.0.2.1          02:00:00:00:00:01  UHLWIir               en1   1175
192.0.2.41         02:00:00:00:00:02  UHLWI                 en1   1192
224.0.0/4          link#16            UmCS                  en1      !
`;
const ROUTES6 = `Routing tables

Internet6:
Destination                             Gateway                                 Flags               Netif Expire
default                                 fe80::1%en1           UGcg                  en1
default                                 fe80::%utun4                            UGcIg               utun4
2001:db8:1:2::/64                 link#16                                 UC                    en1
fe80::%utun4/64                         fe80::2%utun4         UcI                 utun4
ff00::/8                                fe80::2%utun4         UmCI                utun4
2001:db8:1:2::1                   02:00:00:00:00:01                       UHLWI                 en1
`;
const DNS = `DNS configuration

resolver #1
  search domain[0] : example.jp
  nameserver[0] : 2001:db8:1:2::1
  nameserver[1] : 192.0.2.1
  if_index : 16 (en1)
  flags    : Request A records, Request AAAA records
  reach    : 0x00020002 (Reachable,Directly Reachable Address)

resolver #2
  domain   : local
  options  : mdns
  timeout  : 5
  order    : 300000

DNS configuration (for scoped queries)

resolver #1
  search domain[0] : example.jp
  nameserver[0] : 192.0.2.1
  if_index : 16 (en1)
  flags    : Scoped, Request A records
`;
const ROUTE_DEFAULT = '   route to: default\ndestination: default\n    gateway: 192.0.2.1\n  interface: en1\n';
const SYSEXT = `1 extension(s)
--- com.apple.system_extension.driver_extension (Go to 'System Settings > General > Login Items & Extensions > Driver Extensions' to modify these system extension(s))
enabled\tactive\tteamID\tbundleID (version)\tname\t[state]
*\t*\tAAAAAAAAAA\torg.example.Driver (1.0.0/1.0.0)\torg.example.Driver\t[activated enabled]
`;
const LISTEN = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  127.0.0.1.40001        *.*                    LISTEN
tcp6       0      0  ::1.40002              *.*                    LISTEN
tcp4       0      0  192.0.2.34.51000       198.51.100.7.443       ESTABLISHED
`;
const BASE = {
  '/sbin/route -n get default': { code: 0, stdout: ROUTE_DEFAULT },
  '/sbin/route -n get -inet6 default': { code: 0, stdout: ROUTE_DEFAULT },
  '/usr/sbin/netstat -rn -f inet': { code: 0, stdout: ROUTES4 },
  '/usr/sbin/netstat -rn -f inet6': { code: 0, stdout: ROUTES6 },
  '/usr/sbin/scutil --dns': { code: 0, stdout: DNS },
  '/sbin/ifconfig -l': { code: 0, stdout: 'lo0 en0 en1 utun4 bridge100 vmenet0\n' },
  '/usr/sbin/scutil --nc list': { code: 0, stdout: 'Available network connection services in the current set (*=enabled):\n' },
  '/usr/bin/systemextensionsctl list': { code: 0, stdout: SYSEXT },
  '/usr/sbin/netstat -an -p tcp': { code: 0, stdout: LISTEN },
  '/usr/sbin/scutil --proxy': { code: 0, stdout: '<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n  }\n  FTPPassive : 1\n}\n' },
};

function runner(table) {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    if (!ALLOWED_BINS.includes(bin)) throw new Error(`not allowed: ${bin}`);
    return { timedOut: false, ...(table[[bin, ...args].join(' ')] ?? { code: 1, stdout: '' }) };
  };
  return { run, calls };
}
const NOW = () => new Date('2026-10-22T04:30:00Z');

/** Tailscale（tailscaled・--accept-dns=false・--accept-routes=false）接続後の出力 */
function withTailscale(extra = {}) {
  return {
    ...BASE,
    '/sbin/ifconfig -l': { code: 0, stdout: 'lo0 en0 en1 utun4 bridge100 vmenet0 utun8\n' },
    '/usr/sbin/netstat -rn -f inet': { code: 0, stdout: `${ROUTES4}100.64/10          link#40            UCS                 utun8       \n100.100.100.100/32 link#40            UCS                 utun8       \n` },
    '/usr/sbin/netstat -rn -f inet6': { code: 0, stdout: `${ROUTES6}default                                 fe80::%utun8                            UGcIg               utun8       \nfe80::%utun8/64                         fe80::1%utun8                           UcI                 utun8       \nfd7a:115c:a1e0::/48                     fe80::1%utun8                           UCS                 utun8       \n` },
    '/usr/sbin/netstat -an -p tcp': { code: 0, stdout: `${LISTEN}tcp4       0      0  100.101.102.103.40000  *.*                    LISTEN     \n` },
    ...extra,
  };
}

test('読み取り：ARP・近隣の host 経路を除き、宛先と interface（scoped の印）だけを key にする', () => {
  const r4 = parseRouteTable(ROUTES4);
  assert.deepEqual(r4, ['127 lo0', '127.0.0.1 lo0', '192.0.2 en1', '198.51.100/24 bridge100', '224.0.0/4 en1', 'default bridge100 scoped', 'default en1']);
  assert.ok(parseRouteTable(ROUTES6).includes('default utun4 scoped'));
  assert.ok(!parseRouteTable(ROUTES6).some((k) => k.startsWith('2001:db8:1:2::1 ')), '近隣の host 経路は除く');
  assert.equal(parseDefaultInterface({ code: 0, stdout: ROUTE_DEFAULT }), 'en1');
  assert.equal(parseDefaultInterface({ code: 1, stdout: '' }), null);
});

test('読み取り：resolver・system extension・VPN・待ち受け・proxy', () => {
  const d = parseDns(DNS);
  assert.deepEqual(d.main[0], { domain: null, nameservers: ['2001:db8:1:2::1', '192.0.2.1'], search: ['example.jp'], if: 'en1' });
  assert.equal(d.main[1].domain, 'local');
  assert.equal(d.scoped.length, 1);
  assert.deepEqual(parseSystemExtensions(SYSEXT), { driver_extension: 1 });
  assert.equal(parseVpnServices('Available network connection services in the current set (*=enabled):\n* (Connected) X VPN (io.tailscale.ipn.macsys) "Tailscale" [VPN/io.tailscale.ipn.macsys]\n'), 1);
  assert.deepEqual(parseListeners(LISTEN), [], 'loopback と ESTABLISHED は数えない');
  assert.deepEqual(parseListeners('tcp46 0 0  *.22  *.*  LISTEN\ntcp4 0 0  100.101.102.103.40000  *.*  LISTEN\ntcp4 0 0  192.0.2.34.8080  *.*  LISTEN\n'), ['address:8080', 'all:22', 'tailnet:40000']);
  assert.deepEqual(parseProxy('<dictionary> {\n  HTTPEnable : 1\n  HTTPSEnable : 0\n}\n'), { HTTPEnable: 1, HTTPSEnable: 0 });
});

test('snapshot：許可したコマンドだけを固定の argv で呼ぶ', async () => {
  const { run, calls } = runner(BASE);
  const s = await snapshot({ run, now: NOW });
  assert.equal(s.schema, 'network-baseline/v1');
  assert.deepEqual(s.default_route, { inet: 'en1', inet6: 'en1' });
  assert.deepEqual(s.dns.default.search, ['example.jp']);
  assert.equal(s.vpn_services, 0);
  for (const [bin] of calls) assert.ok(ALLOWED_BINS.includes(bin));
  assert.ok(!calls.some((c) => c.join(' ').match(/parallels|prlctl|trading/i)), 'VM・Trading Lab に触れない');
});

test('snapshot：必須のコマンドが失敗したら例外（半端な基準値を保存しない）', async () => {
  const { run } = runner({ ...BASE, '/usr/sbin/scutil --dns': { code: 1, stdout: '' } });
  await assert.rejects(snapshot({ run, now: NOW }), /scutil failed/);
});

test('compare：変化なしは 0 件', async () => {
  const a = await snapshot({ run: runner(BASE).run, now: NOW });
  const b = await snapshot({ run: runner(BASE).run, now: NOW });
  assert.deepEqual(compare(a, b, ['tailscale']), { unexpected: 0, expected: 0, changes: [] });
});

test('compare --expect tailscale：utun・tailnet の経路・scoped default・tailnet の待ち受けは想定どおり', async () => {
  const before = await snapshot({ run: runner(BASE).run, now: NOW });
  const after = await snapshot({ run: runner(withTailscale()).run, now: NOW });
  const r = compare(before, after, ['tailscale']);
  assert.equal(r.unexpected, 0, JSON.stringify(r.changes));
  assert.ok(r.expected >= 6);
  // 同じ変化でも、想定を宣言しなければ全部「想定外」
  assert.equal(compare(before, after, []).expected, 0);
});

test('compare：exit node（scoped でない default）・DNS の書き換え・既定経路の変更・全 interface の待ち受けは想定外', async () => {
  const before = await snapshot({ run: runner(BASE).run, now: NOW });
  const t = withTailscale();
  const bad = withTailscale({
    '/usr/sbin/netstat -rn -f inet': { code: 0, stdout: `${t['/usr/sbin/netstat -rn -f inet'].stdout}0/1                link#40            UCS                 utun8       \n` },
    '/usr/sbin/scutil --dns': { code: 0, stdout: DNS.replace('resolver #2', 'resolver #9\n  domain   : example.ts.net\n  nameserver[0] : 100.100.100.100\n\nresolver #2') },
    '/sbin/route -n get default': { code: 0, stdout: ROUTE_DEFAULT.replace('en1', 'utun8') },
    '/usr/sbin/netstat -an -p tcp': { code: 0, stdout: `${LISTEN}tcp46      0      0  *.22                   *.*                    LISTEN     \n` },
  });
  const r = compare(before, await snapshot({ run: runner(bad).run, now: NOW }), ['tailscale']);
  const items = r.changes.filter((c) => c.kind === 'unexpected').map((c) => c.item);
  assert.ok(items.includes('routes.inet'), 'exit node 相当の経路');
  assert.ok(items.includes('dns.resolvers'));
  assert.ok(r.changes.some((c) => /accept-dns=false/.test(c.detail)));
  assert.ok(items.includes('default_route.inet'));
  assert.ok(items.includes('listeners'));
  // リモートログインを入れる作業だと宣言した時だけ *.22 は想定どおり
  const r2 = compare(before, await snapshot({ run: runner(withTailscale({ '/usr/sbin/netstat -an -p tcp': bad['/usr/sbin/netstat -an -p tcp'] })).run, now: NOW }), ['tailscale', 'remote-login']);
  assert.equal(r2.unexpected, 0, JSON.stringify(r2.changes));
});

test('compare：既定の resolver の変更・interface の消失（VM の bridge 等）は想定外。表示に IP を出さない', async () => {
  const before = await snapshot({ run: runner(BASE).run, now: NOW });
  const after = await snapshot({ run: runner(withTailscale({
    '/sbin/ifconfig -l': { code: 0, stdout: 'lo0 en0 en1 utun4 utun8\n' },
    '/usr/sbin/scutil --dns': { code: 0, stdout: DNS.replace('nameserver[1] : 192.0.2.1', 'nameserver[1] : 198.51.100.53') },
  })).run, now: NOW });
  const r = compare(before, after, ['tailscale']);
  const items = r.changes.filter((c) => c.kind === 'unexpected').map((c) => c.item);
  assert.ok(items.includes('interfaces'));
  assert.ok(items.includes('dns.default.nameservers'));
  const shown = JSON.stringify(r.changes);
  assert.ok(!/192\.0\.2\.1\b|198\.51\.100\.53|2001:db8:1:2/.test(shown), shown);
  assert.match(mask('fd7a:115c:a1e0::/48 utun8'), /fd7a:115c:a1e0::\/48/);
  assert.equal(mask('192.0.2 en1'), '192.0.x.x en1');
});

test('引数：--out は必須・絶対パス・上書きしない・Trading Lab の領域を拒否・--expect は既知の名前だけ', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-netbase-'));
  try {
    const existing = path.join(dir, 'b.json');
    writeFileSync(existing, '{}');
    // 本体は macOS 専用で POSIX の絶対パスだけを受け付ける。--before は存在を確かめないので、OS に依らない POSIX の値にする
    // （Windows の一時フォルダは C:\ で始まり、全体の npm test を Windows で回すと落ちていた。2026-10-22）
    const before = '/tmp/edl-netbase/before.json';
    assert.match(validateArgs(parseArgs(['snapshot'])).join('\n'), /needs --out/);
    assert.match(validateArgs(parseArgs(['snapshot', '--out', 'rel.json'])).join('\n'), /absolute/);
    // 実在する POSIX の絶対パスが要るので、POSIX の OS だけで確かめる
    if (path.sep === '/') assert.match(validateArgs(parseArgs(['snapshot', '--out', existing])).join('\n'), /already exists/);
    assert.match(validateArgs(parseArgs(['snapshot', '--out', '/Users/x/Parallels/n.json'])).join('\n'), /Trading Lab/);
    assert.match(validateArgs(parseArgs(['compare', '--before', before, '--expect', 'exit-node'])).join('\n'), /--expect must be/);
    assert.deepEqual(validateArgs(parseArgs(['compare', '--before', before, '--expect', 'tailscale,remote-login'])), []);
    assert.throws(() => parseArgs(['compare', '--bogus', 'x']), /unknown argument/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('引数：--out は repo の中に置けない（基準値には IP が入り、この repo は public）', () => {
  const errs = validateArgs(parseArgs(['snapshot', '--out', '/tmp/edl-repo/baseline.json']), { repoRoot: '/tmp/edl-repo' }).join('\n');
  assert.match(errs, /outside the repository/);
  assert.deepEqual(validateArgs(parseArgs(['snapshot', '--out', '/tmp/edl-other/baseline.json']), { repoRoot: '/tmp/edl-repo' }), []);
});

test('compare：resolver の domain は上 2 つのラベルだけ表示する（tailnet 名を画面に出さない）', async () => {
  const before = await snapshot({ run: runner(BASE).run, now: NOW });
  const after = await snapshot({ run: runner({ ...BASE, '/usr/sbin/scutil --dns': { code: 0, stdout: DNS.replace('resolver #2', 'resolver #9\n  domain   : tail1234.ts.net\n  nameserver[0] : 100.100.100.100\n\nresolver #2') } }).run, now: NOW });
  const shown = JSON.stringify(compare(before, after, ['tailscale']).changes);
  assert.match(shown, /\*\.ts\.net/);
  assert.ok(!shown.includes('tail1234'), shown);
});

test('makeRunner の allowed：渡した許可リストの外は起動しない（network-baseline が使う）', async () => {
  const calls = [];
  const execFileImpl = (bin, args, opts, cb) => { calls.push(bin); cb(null, 'ok'); };
  const run = makeRunner({ execFileImpl, allowed: ['/usr/sbin/scutil'] });
  assert.deepEqual(await run('/usr/sbin/scutil', ['--dns']), { code: 0, stdout: 'ok', timedOut: false });
  await assert.rejects(run('/bin/df', ['-k', '/']), /command not allowed/);
  assert.deepEqual(calls, ['/usr/sbin/scutil']);
  await assert.rejects(makeRunner({ execFileImpl })('/usr/sbin/scutil', ['--dns']), /command not allowed/, '既定は host-health の許可リスト');
});
