#!/usr/bin/env node
/**
 * 生存信号を 1 回だけ送る（2026-11-05・H6）。connect-heartbeat.sh から。監視の状態は変えない。結果はコードだけ。
 * exit：0＝受け側が受け取った／1＝それ以外
 */
import { sendHeartbeat } from './lib/heartbeat.mjs';

const code = await sendHeartbeat();
console.log(JSON.stringify({ component: 'edl-heartbeat', code }));
process.exitCode = code === 'sent' ? 0 : 1;
