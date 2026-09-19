#!/usr/bin/env node
/*
 * 作業ログ確認Hook — 薄いwrapper（MA-19 / 2026-08-17）
 *
 * このファイルにロジックは無い。判定本体は EN-Knowledge-Vault の
 *   .claude/hooks/guard-devlog-before-commit.js
 * が唯一の正本で、skill-sync.ps1 が ~/.claude/hooks/ へ配布したコピーを
 * ここから require する。
 *
 * なぜwrapperなのか：
 *   2026-08-16の作業ログ欠落の原因は、Skill・Hookの実体を各repoへ手作業で
 *   コピーし、以後どこからも同期されずに凍結したことだった（MA-19監査）。
 *   同じロジックをrepoごとに複製すれば同じドリフトが再発する。そのため
 *   repo側には「本体を呼ぶ」以外の内容を置かない。このファイルは仕様が
 *   変わらない限り更新不要であり、判定ロジックの更新はVault側1か所で完結する。
 *
 * 本体が見つからない場合（新PC・skill-sync未実行）：
 *   git commit に見える呼び出しに限り deny する。黙って allow すると、
 *   まさに今回修正した「静かにログが抜ける」状態へ戻るため。
 *   git commit 以外のBashコマンドは妨げない。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SHARED = path.join(os.homedir(), '.claude', 'hooks', 'guard-devlog-before-commit.js');

// fallback専用の粗い判定（本体側の GIT_COMMIT_RE と役割が違う点に注意：
// ここは「本体が無いときに止めるべきか」だけを決める）。
const LOOKS_LIKE_COMMIT = /(^|[;&|]+)\s*git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+|--?\S+\s+)*commit\b/;

function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason
    }
  }));
  process.exitCode = 0;
}

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch (e) {
  raw = '';
}

let input = null;
if (raw) {
  try {
    input = JSON.parse(raw);
  } catch (e) {
    input = null;
  }
}

if (!input) {
  process.exitCode = 0;                      // 判定対象外：黙って通す
} else {
  let shared = null;
  try {
    shared = require(SHARED);
  } catch (e) {
    shared = null;
  }

  if (shared && typeof shared.run === 'function') {
    shared.run(input);
  } else {
    const cmd = input.tool_input && input.tool_input.command;
    if (input.tool_name === 'Bash' && typeof cmd === 'string' && LOOKS_LIKE_COMMIT.test(cmd)) {
      emit('deny',
        '作業ログ確認Hook：共通Hook本体が見つかりません（' + SHARED + '）。' +
        'EN-Knowledge-Vaultで次を実行して共通基盤を同期してください：' +
        'pwsh -File AI-Workflow-System/01_harness/skill-sync.ps1 -Group AppRepoClaude -Apply');
    } else {
      process.exitCode = 0;
    }
  }
}
