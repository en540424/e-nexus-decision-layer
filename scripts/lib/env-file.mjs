/**
 * Gateway の常駐用 env file の読み込み（2026-09-29・FB-05）。service manager（systemd / launchd / Task Scheduler）から
 * `node scripts/run-gateway.mjs --env-file <path>` で使う。
 *
 * 形式：1 行 1 つの `NAME=value`（`#` で始まる行・空行は無視。引用符・変数展開・複数行は扱わない＝推測で解釈しない）。
 * Secret は値を直接書かず `credential:E-NEXUS/edl/<name>` と書くと、OS 資格情報ストア（Windows 資格情報マネージャー／
 * macOS Keychain）から起動時に読む（有料 provider 鍵と同じ境界：User / Machine 環境変数や平文ファイルに置かない。技術スタック正本§7）。
 * 値はログ・エラー文へ出さない（エラーは行番号と NAME だけ）。
 */
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';

export const EDL_CREDENTIAL_PATTERN = /^E-NEXUS\/edl\/[a-z0-9-]{1,64}$/;
const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** @returns {{ values: Record<string,string>, credentials: Record<string,string>, errors: string[] }} */
export function parseEnvFile(text) {
  const values = {};
  const credentials = {};
  const errors = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) return;
    const eq = t.indexOf('=');
    const name = eq > 0 ? t.slice(0, eq).trim() : '';
    if (!NAME.test(name)) { errors.push(`line ${i + 1}: invalid name`); return; }
    const value = t.slice(eq + 1);
    if (Object.hasOwn(values, name) || Object.hasOwn(credentials, name)) { errors.push(`line ${i + 1}: ${name} is defined twice`); return; }
    if (value.startsWith('credential:')) {
      const target = value.slice('credential:'.length);
      if (!EDL_CREDENTIAL_PATTERN.test(target)) { errors.push(`line ${i + 1}: ${name} credential target must be E-NEXUS/edl/<name>`); return; }
      credentials[name] = target;
    } else {
      values[name] = value;
    }
  });
  return { values, credentials, errors };
}

function windowsReadCommand(target) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "if (-not ('EnxEdlCred' -as [type])) { Add-Type -TypeDefinition @'",
    'using System; using System.Runtime.InteropServices;',
    'public static class EnxEdlCred {',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }',
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);',
    '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);',
    '}',
    "'@ }",
    '$p = [IntPtr]::Zero',
    `if (-not [EnxEdlCred]::CredReadW('${target}', 1, 0, [ref]$p)) { if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 3 } ; exit 1 }`,
    'try { $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][EnxEdlCred+CREDENTIAL]); $v = [Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, [int]($c.CredentialBlobSize / 2)); [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v))); $v = $null } finally { [EnxEdlCred]::CredFree($p) }',
  ].join('\n');
}

/** OS 資格情報ストアから 1 つ読む。無ければ null */
export function readCredential(target, { platform = process.platform, execFileImpl = execFile, timeoutMs = 15000 } = {}) {
  if (!EDL_CREDENTIAL_PATTERN.test(String(target))) return Promise.reject(new Error('credential target outside E-NEXUS/edl/*'));
  const minimalEnv = {};
  for (const k of ['SystemRoot', 'windir', 'SystemDrive', 'PATH', 'Path', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PSModulePath', 'HOME']) {
    if (process.env[k] !== undefined) minimalEnv[k] = process.env[k];
  }
  return new Promise((resolve, reject) => {
    const done = (decode) => (err, stdout) => {
      if (!err) {
        const out = String(stdout ?? '').trim();
        resolve(out === '' ? null : decode(out));
        return;
      }
      if (err.code === 3 || err.code === 44) { resolve(null); return; }
      reject(new Error(`credential backend failed (exit=${err.code ?? 'unknown'})`));
    };
    if (platform === 'win32') {
      const encoded = Buffer.from(windowsReadCommand(target), 'utf16le').toString('base64');
      execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { env: minimalEnv, windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 64 * 1024 }, done((b64) => Buffer.from(b64, 'base64').toString('utf8')));
    } else if (platform === 'darwin') {
      execFileImpl('security', ['find-generic-password', '-s', target, '-a', 'e-nexus', '-w'],
        { env: minimalEnv, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 64 * 1024 }, done((v) => v));
    } else {
      reject(new Error(`no credential backend for platform "${platform}" (use a root-only env file on this host)`));
    }
  });
}

/**
 * env file を読み、credential: の値を解決した env を返す（process.env へは呼び出し側が入れる）。
 * @returns {Promise<Record<string,string>>}
 */
export async function loadEnvFile(path, { read = (p) => readFileSync(p, 'utf8'), readCredentialImpl = readCredential } = {}) {
  const { values, credentials, errors } = parseEnvFile(read(path));
  if (errors.length) throw new Error(`env file: ${errors.join('; ')}`);
  const out = { ...values };
  for (const [name, target] of Object.entries(credentials)) {
    const v = await readCredentialImpl(target);
    if (!v) throw new Error(`env file: ${name} → credential ${target} not found`);
    out[name] = v;
  }
  return out;
}
