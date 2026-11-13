/**
 * Hermes の業務の 1 件実行を macOS の sandbox（Seatbelt・sandbox-exec）に入れる profile（2026-11-13・MA-24・docs/hermes-work.md §11）。
 *
 * 目的：承認された依頼の本文が「鍵の file を読んで summary に写せ」「次の実行で動く hook を置け」と命じても、OS の側でできないこと。
 * Hermes 自身の file の守り（agent/file_safety.py の .env・auth の拒否・HERMES_WRITE_SAFE_ROOT）は v0.22.4 の code が「security boundary ではない」と
 * 書いている＝それに頼らない。
 *
 *   home：業務の実行は Hermes の profile の home（HERMES_HOME＝~/.hermes/profiles/work）で動かす。profile は root（~/.hermes）の依存の環境を
 *       そのまま使い（v0.22.4 hermes_constants._hermes_root_of・pm/environments.install_state_dir＝同期・download をしない）、.env は自分の home の物
 *       だけを読む（hermes_cli/env_loader.load_hermes_dotenv）。profile の home に .env は置かない。TMPDIR は profile の cache/scratch（hermes_bootstrap）
 *   鍵：sandbox の外の loader（perl・hermes の権限）が root の .env から ANTHROPIC_API_KEY の 1 行だけを読み、環境変数で Hermes に渡す
 *       （値は表示しない・引数に置かない）。sandbox の中からは、どこの .env も auth の file も読めない＝常駐の gateway の .env は変えずに済む。
 *   読み・書き：下の buildProfile の allowlist（2026-11-13 独立監査 F1・F2 の後）。
 *   通信：TCP 443 だけ（Anthropic の API）。名前解決は mDNSResponder。ほかの port・UDP は出せない
 *   起動：Keychain・clipboard・AppleScript・通信の道具（security・osascript・curl・ssh など）・sudo は起動できない
 *
 * 残る範囲（受け入れ・記録）：
 *   - profile の state.db・sessions（前の業務の会話）は Hermes の -z が開くので読める。業務の依頼は毎回 Human が全文を読んで承認する
 *   - 443 は名前で絞れない（Seatbelt の限界）。Anthropic 以外へ鍵を送らせないのは、管理の設定の base_url の固定と、profile の config.yaml を書けないこと
 *   - process-exec の拒否は代表の道具だけ（sh・python 等は止めていない）。今の道具は file だけで command を起こせない（terminal 等は管理の設定で無効）
 * 規則は tests/hermes-sandbox.test.mjs が Mac の sandbox-exec で確かめる（Hermes 本体での起動は hermes-work.mjs の課金なしの probe が確かめる）。
 */
const ENV_RE = String.raw`(regex #"/\.env(\.[^/]*)?$") (regex #"/\.envrc$") (regex #"/\.op\.env$")`;
const AUTH_RE = String.raw`(regex #"/auth\.json$") (regex #"/auth\.lock$") (regex #"/\.anthropic_oauth\.json$") (regex #"/webhook_subscriptions\.json$")`;
/** SBPL の文字列の中の path（sandboxArgs が safe な文字だけに限る＝" と \ を含まない）と、regex に埋める path（. を \. に） */
const lit = (p) => `"${p}"`;
const rx = (p) => p.replace(/\./g, '\\.');

/**
 * 読み：Hermes の root のうち code（hermes-agent）・python（tools）・依存（installs）と業務の profile の home、~/.local/bin、
 *       この依頼の 1 file・状態の要約・usage の 1 file・この依頼の結果の 1 file だけ。root の state.db・sessions・memories・logs・backups・cron・
 *       他の profile、outbox の他の結果、inbox の他の依頼は読めない。どこでも .env 系・auth の file は読めない
 * 書き：業務の profile の home（state.db・sessions・logs・cache＝TMPDIR）。ただし config.yaml・hooks・plugins・cron・skills・memories・cwd・
 *       SOUL.md／AGENTS.md・.env は書けない（-z は HERMES_ACCEPT_HOOKS＝hook を自動で受ける＝植えられると次の実行で動く）。
 *       依存の lock（installs/<key>/.install.lock）と lease（…/.leases/）だけ（v0.22.4 hermes_cli/runtime_state.py）。usage の 1 file と、
 *       この依頼の結果の 1 file だけ（Hermes の write_file は一時 file を使わず直接書く：v0.22.4 tools/file_tools.py）。
 *       常駐の gateway の root（plugins・hooks・cron・skills・config・SOUL・code）には書けない
 */
export function buildProfile(p) {
  const R = p.HERMES_ROOT;
  const W = p.WORK_HOME;
  return `(version 1)
(allow default)
(deny file-read-data
  (subpath ${lit(p.USERS_ROOT)}) (subpath "/Volumes") (subpath "/private/tmp")
  (subpath "/Library/Keychains") (subpath "/private/var/db"))
(allow file-read-data
  (subpath ${lit(`${R}/hermes-agent`)}) (subpath ${lit(`${R}/tools`)}) (subpath ${lit(`${R}/installs`)})
  (subpath ${lit(W)}) (subpath ${lit(p.LOCAL_BIN)})
  (literal ${lit(p.REQUEST)}) (literal ${lit(p.BRIEF)}) (literal ${lit(p.USAGE_FILE)}) (literal ${lit(p.RESULT)}))
(deny file-read-data
  ${ENV_RE}
  ${AUTH_RE})
(deny file-write*)
(allow file-write*
  (subpath ${lit(W)})
  (regex #"^${rx(R)}/installs/[^/]+/\\.install\\.lock$")
  (regex #"^${rx(R)}/installs/.+/\\.leases(/[^/]+)?$")
  (literal ${lit(p.USAGE_FILE)}) (literal ${lit(p.RESULT)})
  (subpath ${lit(p.SYSTEM_TMP)}) (subpath "/dev"))
(deny file-write*
  (literal ${lit(`${W}/config.yaml`)}) (subpath ${lit(`${W}/hooks`)}) (subpath ${lit(`${W}/plugins`)}) (subpath ${lit(`${W}/cron`)})
  (subpath ${lit(`${W}/skills`)}) (subpath ${lit(`${W}/memories`)}) (subpath ${lit(`${W}/cwd`)})
  (regex #"/(SOUL|AGENTS|CLAUDE)\\.md$") (regex #"/\\.hermes\\.md$")
  ${ENV_RE}
  ${AUTH_RE})
(deny process-exec
  (literal "/usr/bin/security") (literal "/usr/bin/osascript") (literal "/usr/bin/curl") (literal "/usr/bin/nc")
  (literal "/usr/bin/ssh") (literal "/usr/bin/scp") (literal "/usr/bin/sftp") (literal "/usr/bin/rsync")
  (literal "/usr/bin/open") (literal "/bin/launchctl") (literal "/usr/bin/pbcopy") (literal "/usr/bin/pbpaste")
  (literal "/usr/sbin/screencapture") (literal "/usr/bin/sudo"))
(deny appleevent-send)
(deny network-outbound)
(allow network-outbound (remote tcp "*:443"))
(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
`;
}

export const PARAMS = Object.freeze(['USERS_ROOT', 'HERMES_ROOT', 'WORK_HOME', 'LOCAL_BIN', 'USAGE_FILE', 'REQUEST', 'BRIEF', 'RESULT', 'SYSTEM_TMP']);
const SAFE_PATH = /^\/[A-Za-z0-9._/-]{1,400}$/;

/** 業務の profile の名前（HERMES_HOME＝<root>/profiles/<name>） */
export const WORK_PROFILE = 'work';

/** sandbox-exec の引数（-p だけ。path は profile に埋める＝絶対・安全な文字だけ・.. なし。WORK_HOME は root の profiles の下） */
export function sandboxArgs(params) {
  for (const k of PARAMS) {
    const v = params[k];
    if (typeof v !== 'string' || !SAFE_PATH.test(v) || v.split('/').includes('..') || v.endsWith('/')) throw new Error(`sandbox param ${k} is not a safe absolute path`);
  }
  if (!params.WORK_HOME.startsWith(`${params.HERMES_ROOT}/profiles/`)) throw new Error('sandbox param WORK_HOME must be under HERMES_ROOT/profiles');
  return ['-p', buildProfile(params)];
}

/** 本番の値（hermes ユーザー・macOS） */
export function productionParams({ hermesUser = 'hermes', request, brief, result, usage }) {
  const home = `/Users/${hermesUser}`;
  return {
    USERS_ROOT: '/Users', HERMES_ROOT: `${home}/.hermes`, WORK_HOME: `${home}/.hermes/profiles/${WORK_PROFILE}`, LOCAL_BIN: `${home}/.local/bin`,
    USAGE_FILE: usage, REQUEST: request, BRIEF: brief, RESULT: result, SYSTEM_TMP: '/private/var/folders',
  };
}

/**
 * sandbox の外で鍵を読み、環境変数だけに入れて exec する loader（perl・hermes の権限で動く）。値は表示しない・引数に置かない。
 *   perl -e LOADER <root の .env> <秒> <作業フォルダ> <command…>
 * .env の ANTHROPIC_API_KEY の行だけを読む。無い・形が違えば exit 65。umask 027（outbox の結果を group が読める）。
 * KEY_PROBE=invalid の時は .env を読まず、無効な値を入れる（課金されない起動の確かめ：Anthropic は 401 を返す）
 */
export const LOADER = String.raw`use strict;
my ($kf, $secs, $wd) = splice(@ARGV, 0, 3);
my $k;
if (($ENV{KEY_PROBE} // '') eq 'invalid') { $k = 'sk-ant-api03-invalid-e-nexus-probe-' . ('0' x 40); }
else {
  open(my $f, '<', $kf) or exit 64;
  while (my $l = <$f>) { if ($l =~ /^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*["']?([A-Za-z0-9_\-]{20,400})["']?\s*$/) { $k = $1; } }
  close $f;
}
defined $k or exit 65;
delete $ENV{KEY_PROBE};
$ENV{ANTHROPIC_API_KEY} = $k;
umask 027;
chdir $wd or exit 67;
alarm $secs;
exec { $ARGV[0] } @ARGV or exit 66;
`;
