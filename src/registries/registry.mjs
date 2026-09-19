/**
 * Registry：Project / Skill / Agent / Model の候補台帳。
 * 判定エンジン（Jev等）にファイルシステムを探索させず、ここから「必要な候補だけ」を渡す。
 * 台帳の実体は registries/*.json（機械可読）。Vault側の人間向け台帳（Skill台帳・managed-repos.json・Advisor正本等）が
 * 上位の正本であり、ここはその派生スナップショット。矛盾したらVault側を優先し、この JSON を直す。
 */
import { readJson } from '../schemas/loader.mjs';
import { RegistryError } from '../core/errors.mjs';

const FILES = {
  projects: 'registries/projects.json',
  skills: 'registries/skills.json',
  agents: 'registries/agents.json',
  models: 'registries/models.json',
};

export const REGISTRY_KINDS = Object.freeze(Object.keys(FILES));

export function loadRegistry(kind) {
  if (!FILES[kind]) throw new RegistryError(`unknown registry kind: ${kind}`);
  const doc = readJson(FILES[kind]);
  if (!Array.isArray(doc.entries)) throw new RegistryError(`registry ${kind} has no entries[]`);
  return doc.entries;
}

export function getEntry(kind, id) {
  const e = loadRegistry(kind).find((x) => x.id === id);
  if (!e) throw new RegistryError(`${kind} not found: ${id}`);
  return e;
}

/**
 * scope 解決：global + 指定 project の候補のみ返す（他 project 固有の候補は渡さない）。
 * 例: resolveCandidates('skills', { projectId: 'travel-rate-camera' })
 */
export function resolveCandidates(kind, { projectId = null, tags = [] } = {}) {
  return loadRegistry(kind).filter((e) => {
    const scopeOk = e.scope === 'global' || (projectId !== null && e.scope === projectId);
    const tagOk = tags.length === 0 || (e.tags ?? []).some((t) => tags.includes(t));
    return scopeOk && tagOk && e.status !== 'retired';
  });
}

export function resolveProject(projectIdOrAlias) {
  const p = loadRegistry('projects').find(
    (x) => x.id === projectIdOrAlias || (x.aliases ?? []).includes(projectIdOrAlias),
  );
  if (!p) throw new RegistryError(`project not found: ${projectIdOrAlias}`);
  return p;
}

/** 4台帳すべての最低限の整合チェック（id重複・scope参照先の存在） */
export function checkRegistries() {
  const problems = [];
  const projectIds = new Set(loadRegistry('projects').map((p) => p.id));
  for (const kind of REGISTRY_KINDS) {
    const seen = new Set();
    for (const e of loadRegistry(kind)) {
      if (!e.id) problems.push(`${kind}: entry without id`);
      if (seen.has(e.id)) problems.push(`${kind}: duplicate id ${e.id}`);
      seen.add(e.id);
      if (kind !== 'projects' && e.scope && e.scope !== 'global' && !projectIds.has(e.scope)) {
        problems.push(`${kind}/${e.id}: scope ${e.scope} is not a registered project`);
      }
    }
  }
  return problems;
}
