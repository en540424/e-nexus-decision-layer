/**
 * Runtime environment（2026-09-26・E-NEXUS共通基盤「コードは共通、実行環境は分離」）。
 * 上位原則の正本は Vault「技術スタック選定・管理_正本」§3-8、Gateway への具体適用は Decision Layer 正本 §18-7・docs/gateway.md §12。
 *
 *   dev        = PERSONAL / DEV（本人の開発・実験。一般ユーザーを接続しない）
 *   staging    = release candidate の検証（Production 相当構成・synthetic data）
 *   production = 一般販売・外部ユーザー向け（確認済み version のみ）
 *
 * 環境は Gateway を動かしている runtime の設定（EDL_ENVIRONMENT）で決まり、consumer の request 本文では決まらない。
 * 未設定は dev（今ある実行環境は PERSONAL / DEV だけ）。不正値は起動を拒否する（推測で補わない＝fail-closed）。
 *
 * 注意：engine の `mode: 'production' | 'verification'`（mock-jev を入れるか）は判定モードであり、この実行環境とは別物。
 */
export const RUNTIME_ENVIRONMENTS = Object.freeze(['dev', 'staging', 'production']);
export const DEFAULT_RUNTIME_ENVIRONMENT = 'dev';
export const ENVIRONMENT_ENV_VAR = 'EDL_ENVIRONMENT';

export function isRuntimeEnvironment(value) {
  return RUNTIME_ENVIRONMENTS.includes(value);
}

export function resolveRuntimeEnvironment(env = process.env) {
  const raw = env[ENVIRONMENT_ENV_VAR];
  if (raw === undefined || raw === '') return DEFAULT_RUNTIME_ENVIRONMENT;
  if (!isRuntimeEnvironment(raw)) {
    throw new Error(`${ENVIRONMENT_ENV_VAR}=${JSON.stringify(raw)} is not a runtime environment (allowed: ${RUNTIME_ENVIRONMENTS.join('|')})`);
  }
  return raw;
}
