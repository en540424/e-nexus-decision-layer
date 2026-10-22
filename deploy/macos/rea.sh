#!/bin/sh
# REA（Reverse Engineer Anything・npm `rea-agents`・MIT）を Mac Runtime の領域へ入れる・状態を見る・外す（2026-10-22・MA-22 S5）。
# agent への登録（`rea-agents setup`）はしない＝Claude Code・Codex・Cursor の設定・skill に触れない。登録は Human が project の範囲だけで行う
# （同じ OS user の別 project の Claude Code セッションへ広げない。手順は `register-hint`）。
#
#   sh deploy/macos/rea.sh install --version <x.y.z> [--prefix <abs>]
#   sh deploy/macos/rea.sh status [--prefix <abs>]
#   sh deploy/macos/rea.sh uninstall --version <x.y.z> [--prefix <abs>]
#   sh deploy/macos/rea.sh register-hint --project <abs> [--prefix <abs>]
#   sh deploy/macos/rea.sh deny-settings [--prefix <abs>]   # 登録するフォルダの .claude/settings.json に入れる拒否リスト（入れた版から作る）
#
# install：版は x.y.z だけ（latest・範囲は拒否）。<prefix>/<version>/ へ `npm install` を、optional 依存なし（frida＝process への注入、
#   node-pty の native 部品＝PTY での実行を入れない＝静的な解析だけ）・install script なし・npm cache も prefix の中・可能なら taskpolicy -b で。
#   入れた後に `npm audit signatures`（registry の署名。provenance の attestation があればそれも検証。attestation が無いことでは失敗しない）を
#   通らなければ消して失敗にする。<prefix>/current を新しい版へ向ける
#   （前の版は残す＝戻すときは current を向け直す）。Hopper・Ghidra・IDA は入れない。
# status：入っている版・current・`rea --version`、Claude Code（~/.claude.json の user 範囲）・Codex・Cursor の設定に REA の登録が
#   あるか（user 範囲の登録は WARN）。設定の中身は表示しない（key 名だけ見る）。
# uninstall：<prefix>/<version>/ だけを消す（印のファイル .edl-rea がある場所に限る）。agent の設定は変えず、登録が残っていれば知らせる。
#   REA が解析の時に作る ~/.rea（cache・state）は消さない（Evidence を残す。消すなら Human が中身を見てから）。
# 既定の prefix：$HOME/e-nexus-runtime/tools/rea。Trading Lab の領域（Parallels・trading-lab・移植キット）は prefix に取らない。
set -u

CMD="${1:-}"; [ $# -gt 0 ] && shift
VERSION=''; PREFIX="${HOME}/e-nexus-runtime/tools/rea"; PROJECT=''
# 値の無い引数で shift 2 が失敗すると、bash（macOS の /bin/sh）では同じ引数のまま無限に回る
need() { [ $# -ge 2 ] || { echo "$1 needs a value" >&2; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --version) need "$@"; VERSION="$2"; shift 2 ;;
    --prefix) need "$@"; PREFIX="$2"; shift 2 ;;
    --project) need "$@"; PROJECT="$2"; shift 2 ;;
    -h|--help) awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "rea.sh: $*" >&2; exit 2; }
case "$PREFIX" in /*) ;; *) die "--prefix must be an absolute path" ;; esac
if printf '%s' "$PREFIX $PROJECT" | grep -Eiq 'parallels|trading-?lab|mac-mini-migration-kit'; then die "Trading Lab の領域は使わない"; fi
case "$PREFIX $PROJECT" in *[\"\'\`\$\;\&\|\<\>]*) die "path contains characters that are not allowed" ;; esac
check_version() { printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "--version must be x.y.z（latest・範囲は使わない）"; }
# CPU・I/O・ネットワークを同居の workload に譲る（macOS の taskpolicy。無ければそのまま）
bg() { if [ -x /usr/sbin/taskpolicy ]; then /usr/sbin/taskpolicy -b "$@"; else "$@"; fi; }

# agent の設定に REA の登録があるか（key 名だけ。値は読まない）
registrations() {
  node -e '
    const fs = require("fs"); const p = require("path"); const home = process.env.HOME;
    const out = [];
    try {
      const j = JSON.parse(fs.readFileSync(p.join(home, ".claude.json"), "utf8"));
      const isRea = (k) => /^rea$|rea-agents|reverse-engineer/i.test(k);
      if (Object.keys(j.mcpServers || {}).some(isRea)) out.push("WARN claude-code: user 範囲に REA の MCP 登録がある（同じ OS user の全 project に出る。project 範囲へ移す）");
      for (const [dir, v] of Object.entries(j.projects || {})) if (Object.keys((v && v.mcpServers) || {}).some(isRea)) out.push("INFO claude-code: local 範囲の登録（1 project）");
    } catch { /* 無ければ登録なし */ }
    for (const [name, f] of [["codex", ".codex/config.toml"], ["cursor", ".cursor/mcp.json"]]) {
      try { if (/rea-agents|mcp_servers\.rea\b|"rea"\s*:/i.test(fs.readFileSync(p.join(home, f), "utf8"))) out.push(`WARN ${name}: 設定に REA の記述がある`); } catch { /* 無し */ }
    }
    try { if (fs.readdirSync(p.join(home, ".claude", "skills")).some((d) => /reverse-engineer|^rea$/i.test(d))) out.push("WARN claude-code: user 範囲の skill に REA がある"); } catch { /* 無し */ }
    console.log(out.length ? out.join("\n") : "INFO agents: REA の登録なし（Claude Code の user 範囲・Codex・Cursor）");
  '
}

case "$CMD" in
  install)
    check_version
    command -v node >/dev/null 2>&1 || die "node not found"
    command -v npm >/dev/null 2>&1 || die "npm not found"
    # rea-agents の engines：^22.19.0 || ^24.11.0 || >=26.0.0
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>=26||(a===24&&b>=11)||(a===22&&b>=19)?0:1)' || die "node $(node -v) does not meet rea-agents engines (^22.19 || ^24.11 || >=26)"
    DIR="${PREFIX}/${VERSION}"
    [ -e "$DIR" ] && die "${DIR} already exists（入れ直すなら先に uninstall）"
    mkdir -p "$DIR" "${PREFIX}/.npm-cache" || exit 1
    chmod 700 "$PREFIX"
    printf 'rea-agents@%s installed by deploy/macos/rea.sh %s\n' "$VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${DIR}/.edl-rea"
    printf '{"name":"edl-rea-%s","private":true}\n' "$VERSION" > "${DIR}/package.json"
    if ! bg npm install --prefix "$DIR" --cache "${PREFIX}/.npm-cache" --omit=optional --ignore-scripts --save-exact --no-fund --no-audit --no-update-notifier "rea-agents@${VERSION}"; then
      rm -rf "$DIR"; echo "rea.sh: npm install failed（${DIR} は消した）" >&2; exit 1
    fi
    if ! bg npm audit signatures --prefix "$DIR" --cache "${PREFIX}/.npm-cache" --no-update-notifier; then
      rm -rf "$DIR"; echo "rea.sh: npm audit signatures failed（署名・provenance を確認できない。${DIR} は消した）" >&2; exit 1
    fi
    got=$(node -p 'require(process.argv[1]).version' "${DIR}/node_modules/rea-agents/package.json" 2>/dev/null)
    [ "$got" = "$VERSION" ] || { rm -rf "$DIR"; echo "rea.sh: installed version ${got:-?} != ${VERSION}" >&2; exit 1; }
    ln -sfn "$VERSION" "${PREFIX}/current"
    echo "installed rea-agents@${VERSION} -> ${PREFIX}/current（agent へは未登録）"
    echo "run: ${PREFIX}/current/node_modules/.bin/rea --help"
    ;;
  status)
    if [ -d "$PREFIX" ]; then
      cur=$(readlink "${PREFIX}/current" 2>/dev/null || echo none)
      for d in "$PREFIX"/*/; do [ -L "${d%/}" ] && continue; [ -f "${d}.edl-rea" ] && echo "INFO installed: $(basename "$d")"; done
      echo "INFO current: ${cur}"
      if [ -x "${PREFIX}/current/node_modules/.bin/rea" ]; then echo "INFO rea --version: $(bg "${PREFIX}/current/node_modules/.bin/rea" --version 2>/dev/null | head -n 1)"; fi
    else
      echo "INFO not installed under ${PREFIX}"
    fi
    command -v rea >/dev/null 2>&1 && echo "INFO rea on PATH: $(command -v rea)（この道具の外で入った REA）"
    registrations
    ;;
  uninstall)
    check_version
    DIR="${PREFIX}/${VERSION}"
    [ -f "${DIR}/.edl-rea" ] || die "${DIR} is not an install made by rea.sh（消さない）"
    rm -rf "$DIR"
    [ "$(readlink "${PREFIX}/current" 2>/dev/null)" = "$VERSION" ] && rm -f "${PREFIX}/current"
    echo "removed ${DIR}"
    registrations
    ;;
  register-hint)
    [ -n "$PROJECT" ] || die "register-hint needs --project <abs>"
    case "$PROJECT" in /*) ;; *) die "--project must be an absolute path" ;; esac
    BIN="${PREFIX}/current/node_modules/.bin/rea"
    cat <<EOF
# REA の登録は Human が行う（この道具は実行しない）。1 つのフォルダだけ（REA 公式 docs「Limit REA to one project」の local 範囲）。
# \`rea-agents setup\` は使わない：Claude Code では常に user 範囲（~/.claude.json の mcpServers と ~/.claude/skills）に書き、
# 同じ OS user の別 project の Claude Code セッションにも REA が出る。
# 1) そのフォルダで（CLAUDE_CONFIG_DIR は未設定のまま）：
cd "${PROJECT}" && claude mcp add --scope local rea -- "${BIN}" mcp
# 2) 同じフォルダの .claude/settings.json の permissions.deny で、process を起動・接続する道具（Frida・process capture・
#    native call の観察・native UI・Electron／browser の scenario・adb）を止める。REA 自身には許可の仕組みが無い（公式 docs）：
#    既存の settings.json が無い時だけ：mkdir -p "${PROJECT}/.claude" && [ ! -e "${PROJECT}/.claude/settings.json" ] && sh deploy/macos/rea.sh deny-settings --prefix "${PREFIX}" > "${PROJECT}/.claude/settings.json"
#    既にある時は上書きせず、deny-settings の出力の permissions.deny を手で足す
# 3) 確認：そのフォルダで claude mcp list に rea が出る／別のフォルダでは出ない／ sh deploy/macos/rea.sh status に WARN が無い
# 4) 外す：cd "${PROJECT}" && claude mcp remove --scope local rea
EOF
    ;;
  deny-settings)
    # 入れた版の REA が道具ごとに宣言している効果（dist/contracts/toolEffects.js の TOOL_EFFECTS）から、process の起動・外部コードの実行・
    # 対象の変更・端末の変更・UI 操作・データの破棄・ネットワーク、または名前が Frida・capture・observe・adb・debug・scenario の道具を拒否する
    # Claude Code の設定を出す（登録するフォルダの .claude/settings.json 用）。宣言は REA 自身の申告で、許可の仕組みではない。
    # 例外は STATIC_HELPERS だけ：渡したファイルを解析する補助の process（解析の worker・plist／codesign の読み取り等）しか起動しない道具で、
    # process の起動だけを理由には拒否しない（ほかの効果があれば拒否）。新しい版で増えた道具は既定で拒否される
    EFF="${PREFIX}/current/node_modules/rea-agents/dist/contracts/toolEffects.js"
    [ -f "$EFF" ] || die "${EFF} がない（版で場所が変わった可能性。手で確かめる）"
    node --input-type=module -e '
      const { pathToFileURL } = await import("node:url");
      const { TOOL_EFFECTS } = await import(pathToFileURL(process.argv[1]).href);
      const STATIC_HELPERS = new Set(["analyze_javascript_application", "recover_javascript_sources", "inspect_artifact", "extract_artifact", "inspect_macho",
        "inspect_signature", "inspect_plist", "list_architectures", "demangle_swift", "inspect_asset_catalog", "inspect_binary_layout"]);
      const risky = (n, e) => (e.launchesProcess && !STATIC_HELPERS.has(n)) || e.executesForeignCode || e.mutatesTarget || e.mutatesDevice || e.changesUiState
        || e.mayDiscardData || e.accessesNetwork || /frida|capture|observe|adb|debug|gdb|lldb|cutter|scenario|install/i.test(n);
      const deny = Object.keys(TOOL_EFFECTS).filter((n) => risky(n, TOOL_EFFECTS[n])).sort().map((n) => `mcp__rea__${n}`);
      if (deny.length === 0) { console.error("no tool denied: refuse to print an empty list"); process.exit(1); }
      console.log(JSON.stringify({ permissions: { deny } }, null, 2));
    ' "$EFF"
    ;;
  *) awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "$0"; exit 2 ;;
esac
