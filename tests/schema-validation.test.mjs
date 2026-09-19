import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/schemas/validate.mjs';
import { readJson, listDecisionTypes, loadDecisionType } from '../src/schemas/loader.mjs';
import { makeEngine, gateRequest } from './helpers.mjs';
import { SchemaValidationError, DecisionLayerError } from '../src/core/errors.mjs';

test('validator: type / required / enum / additionalProperties / range', () => {
  const schema = {
    type: 'object', required: ['a'], additionalProperties: false,
    properties: { a: { type: 'string', enum: ['x', 'y'] }, n: { type: 'number', minimum: 0, maximum: 1 } },
  };
  assert.deepEqual(validate(schema, { a: 'x', n: 0.5 }), []);
  assert.ok(validate(schema, {}).some((e) => e.includes('required')));
  assert.ok(validate(schema, { a: 'z' }).some((e) => e.includes('enum')));
  assert.ok(validate(schema, { a: 'x', extra: 1 }).some((e) => e.includes('additional property')));
  assert.ok(validate(schema, { a: 'x', n: 2 }).some((e) => e.includes('maximum')));
});

test('all decision types in the index have loadable schemas with input+outcome', () => {
  const types = listDecisionTypes();
  assert.ok(Object.keys(types).length >= 6);
  for (const id of Object.keys(types)) {
    const dt = loadDecisionType(id);
    assert.ok(dt.schema.properties.input, `${id}: input schema`);
    assert.ok(dt.schema.properties.outcome, `${id}: outcome schema`);
    assert.equal(dt.schema.properties.outcome.additionalProperties, false, `${id}: outcome must be closed`);
  }
});

test('engine rejects request missing required fields', async () => {
  const { engine } = makeEngine();
  await assert.rejects(() => engine.decide({ decision_type: 'paid-generation-gate' }), SchemaValidationError);
});

test('engine rejects unknown decision_type', async () => {
  const { engine } = makeEngine();
  await assert.rejects(
    () => engine.decide({ decision_type: 'nope', application_id: 'a', project_id: 'openmontage', input: {} }),
    (e) => e instanceof DecisionLayerError && e.code === 'UNKNOWN_DECISION_TYPE',
  );
});

test('engine rejects invalid decision-type input (enum violation)', async () => {
  const { engine } = makeEngine();
  await assert.rejects(() => engine.decide(gateRequest({ asset_kind: 'hologram', purpose: 'x' })), SchemaValidationError);
});

test('engine result always matches decision-result schema', async () => {
  const { engine } = makeEngine();
  const r = await engine.decide(gateRequest({ asset_kind: 'subtitle', purpose: 'jp caption' }));
  assert.deepEqual(validate(readJson('schemas/common/decision-result.schema.json'), r), []);
});
