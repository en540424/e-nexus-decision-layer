/**
 * 依存ゼロの JSON Schema サブセット検証器。
 * 対応: type（配列可）/ required / properties / additionalProperties(false) / enum / const /
 *       minimum / maximum / minLength / maxLength / items / oneOf
 * 目的は「typed decision の入出力が宣言どおりか」を機械的に保証すること。フル JSON Schema は目指さない。
 */
import { SchemaValidationError } from '../core/errors.mjs';

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && Number.isInteger(v)) return 'integer';
  return typeof v;
}

function matchesType(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

export function validate(schema, value, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected type ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
  }
  // maxLength（2026-09-23 content-publish-gate）：Jev へ渡す自由文（title / summary / excerpt）を有限に保つため
  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) {
    errors.push(`${path}: string longer than maxLength ${schema.maxLength}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) validate(sub, value[key], `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${path}.${key}: additional property not allowed`);
      }
    }
  }
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((s) => validate(s, value, path, []).length === 0).length;
    if (ok !== 1) errors.push(`${path}: must match exactly one of oneOf (matched ${ok})`);
  }
  return errors;
}

export function assertValid(schema, value, label = 'value') {
  const errors = validate(schema, value);
  if (errors.length) throw new SchemaValidationError(errors, { label });
  return value;
}
