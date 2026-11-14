import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DeepSeekError,
  explainEvidence,
  suggestFilters,
  type DeepSeekEvidencePacket,
  type DeepSeekOptions,
} from '../src/lib/deepseek.ts';

const fixtureKey = 'fixture-deepseek-key';
const env = { DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: fixtureKey };
const fields = { fuel: ['ethylene', 'methane'], pressure: [101.3], reducedGravity: [true] };
const packet: DeepSeekEvidencePacket = {
  scope: 'selected-comparison',
  evidence: [
    { id: 'fixture-pressure', status: 'reported', text: 'Synthetic pressure observation.',
      numbers: [{ label: 'Chamber pressure', value: 101.3, unit: 'kPa' }] },
    { id: 'fixture-delta', status: 'derived', text: 'Synthetic pressure difference.',
      numbers: [{ label: 'Pressure difference', value: -0.7, unit: 'kPa' }] },
    { id: 'fixture-gap', status: 'unknown', text: 'Synthetic gap in oxygen data.' },
  ],
  limitations: ['Synthetic fixture data.'],
};
const reported = {
  status: 'reported',
  text: 'The selected records include a chamber pressure observation.',
  citationIds: ['fixture-pressure'],
};

function response(content: string | null, finishReason = 'stop') {
  return Response.json({
    model: 'deepseek-flash-fixture',
    choices: [{ finish_reason: finishReason, message: {
      role: 'assistant', content, reasoning_content: 'Private fixture reasoning',
    } }],
    usage: { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54 },
  });
}

function fixture(output: unknown): DeepSeekOptions {
  return { env, fetchImpl: async () => response(JSON.stringify(output)) };
}

function errorCode(code: DeepSeekError['code'], status?: number) {
  return (error: unknown) => error instanceof DeepSeekError
    && error.code === code && error.status === status && !error.message.includes(fixtureKey);
}

const neverFetch: typeof fetch = async () => {
  assert.fail('The test expected no provider call');
};

test('sends a single bounded JSON-mode request to DeepSeek and returns typed proposals and metadata', async () => {
  let calls = 0;
  const result = await suggestFilters('  Ethylene in reduced gravity?  ', fields, {
    env,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.cache, 'no-store');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${fixtureKey}`);
      assert.equal(typeof init?.body, 'string');
      const bodyText = String(init?.body);
      assert.ok(!bodyText.includes(fixtureKey));
      const body = JSON.parse(bodyText);
      assert.equal(body.model, 'deepseek-flash');
      assert.equal(body.stream, false);
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.deepEqual(body.thinking, { type: 'disabled' });
      assert.equal(body.max_tokens, 400);
      assert.match(body.messages[0].content, /json/i);
      assert.deepEqual(JSON.parse(body.messages[1].content), {
        question: 'Ethylene in reduced gravity?',
        supportedFields: fields,
      });
      return response('{"filters":{"fuel":"ethylene","pressure":101.3,"reducedGravity":true}}');
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.filters, { fuel: 'ethylene', pressure: 101.3, reducedGravity: true });
  assert.deepEqual(result.model, {
    requested: 'deepseek-flash',
    returned: 'deepseek-flash-fixture',
    promptVersion: 'filters-1',
    configVersion: 'deepseek-7',
    usage: { inputTokens: 42, outputTokens: 12, totalTokens: 54 },
  });
  assert.ok(!JSON.stringify(result).includes('Private fixture reasoning'));
});

test('keeps absent provider identity and usage unknown', async () => {
  const result = await suggestFilters('Fuel?', fields, { env, fetchImpl: async () => Response.json({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"filters":{}}' } }],
  }) });
  assert.deepEqual(result.filters, {});
  assert.equal(result.model.returned, null);
  assert.equal(result.model.usage, null);
});

test('rejects unknown filter fields, values and coerced types', async () => {
  for (const output of [
    { filters: { fuel: 'propane' } },
    { filters: { pressure: '101.3' } },
    { filters: { study: 'fixture' } },
    { filters: { constructor: 'fixture' } },
    { filters: {}, extra: true },
  ]) {
    await assert.rejects(suggestFilters('Fuel?', fields, fixture(output)), errorCode('invalid-response'));
  }
});

test('validates proposals against the exact filter values sent', async () => {
  const mutableFields = { fuel: ['ethylene'] };
  await assert.rejects(suggestFilters('Fuel?', mutableFields, {
    env,
    fetchImpl: async () => {
      mutableFields.fuel[0] = 'methane';
      return response('{"filters":{"fuel":"methane"}}');
    },
  }), errorCode('invalid-response'));
});

test('copies numeric values and units from cited evidence for reported and derived claims', async () => {
  const result = await explainEvidence('How do chamber pressures compare?', packet, {
    env,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.max_tokens, 700);
      assert.match(body.messages[0].content, /at most 4 distinct citation IDs per claim/);
      assert.deepEqual(JSON.parse(body.messages[1].content), { question: 'How do chamber pressures compare?', ...packet });
      return response(JSON.stringify({ status: 'supported', claims: [
        reported,
        { status: 'derived', text: 'The selected chamber pressures differ.', citationIds: ['fixture-delta'] },
        { status: 'insufficient', text: 'Oxygen concentration is unavailable.', citationIds: ['fixture-gap'] },
      ] }));
    },
  });
  assert.equal(result.scope, 'selected-comparison');
  assert.equal(result.model?.promptVersion, 'evidence-3');
  assert.deepEqual(result.claims.map(({ measurements }) => measurements), [
    [{ citationId: 'fixture-pressure', label: 'Chamber pressure', value: 101.3, unit: 'kPa' }],
    [{ citationId: 'fixture-delta', label: 'Pressure difference', value: -0.7, unit: 'kPa' }],
    [],
  ]);
});

test('rejects fabricated and duplicate citations, mismatched statuses and model-authored measurements', async () => {
  for (const claim of [
    { ...reported, citationIds: ['fixture-other'] },
    { ...reported, citationIds: ['fixture-pressure', 'fixture-pressure'] },
    { ...reported, citationIds: ['fixture-gap'] },
    { ...reported, citationIds: [] },
    { ...reported, status: 'derived' },
    { ...reported, measurements: [{ value: 90, unit: 'kPa' }] },
  ]) {
    await assert.rejects(explainEvidence('What was the pressure?', packet,
      fixture({ status: 'supported', claims: [claim] })), errorCode('invalid-response'));
  }
  await assert.rejects(explainEvidence('What was the pressure?', packet,
    fixture({ status: 'supported', claims: [reported], metadata: {} })), errorCode('invalid-response'));
});

test('withholds quantity-bearing siblings and retains only validated findings and their source measurements', async () => {
  const accepted = {
    status: 'reported',
    text: 'The selected records include a pressure observation.',
    citationIds: ['fixture-pressure'],
  };
  const result = await explainEvidence('What was recorded?', packet, fixture({
    status: 'supported',
    claims: [
      { ...accepted, text: 'The pressure in FLEX-001 was 90 kPa.' },
      accepted,
      { ...accepted, text: 'The pressure was ninety kilopascals.' },
    ],
  }));
  assert.equal(result.status, 'supported');
  assert.equal(result.withheldClaims, 2);
  assert.equal(result.model?.configVersion, 'deepseek-7');
  assert.equal(result.model?.promptVersion, 'evidence-3');
  assert.deepEqual(result.claims, [{
    ...accepted,
    scope: 'selected-comparison',
    measurements: [{ citationId: 'fixture-pressure', label: 'Chamber pressure', value: 101.3, unit: 'kPa' }],
  }]);

  const complete = await explainEvidence('What was recorded?', packet, fixture({
    status: 'supported', claims: [accepted],
  }));
  assert.ok(!Object.hasOwn(complete, 'withheldClaims'));
});

test('uses evidence-only insufficiency when every finding is withheld and keeps unknown citations fail-closed', async () => {
  const finding = {
    status: 'reported', text: 'The chamber pressure was 90 kPa.', citationIds: ['fixture-pressure'],
  };
  const gap = { status: 'insufficient', text: 'Oxygen was unreported.', citationIds: ['fixture-gap'] };
  const valid = { ...finding, text: 'The chamber pressure was recorded.' };
  const fallback = await explainEvidence('What was recorded?', packet, fixture({
    status: 'supported', claims: [finding, gap],
  }));
  assertQuantityFallback(fallback, finding.text);
  assert.ok(!JSON.stringify(fallback).includes(gap.text));
  for (const claims of [
    [valid, { ...finding, citationIds: ['unknown-id'] }],
    [valid, { ...valid, citationIds: ['unknown-id'] }],
  ]) {
    await assert.rejects(explainEvidence('What was recorded?', packet, fixture({ status: 'supported', claims })),
      errorCode('invalid-response'));
  }
  const insufficient = await explainEvidence('What was recorded?', packet, fixture({
    status: 'insufficient', claims: [gap],
  }));
  assert.equal(insufficient.status, 'insufficient');
  assert.ok(!Object.hasOwn(insufficient, 'withheldClaims'));
});

function assertQuantityFallback(result: Awaited<ReturnType<typeof explainEvidence>>, rejectedText: string) {
  assert.equal(result.status, 'insufficient');
  assert.deepEqual(result.provenance, { kind: 'deterministic-evidence', ruleVersion: 'claim-withholding-1' });
  assert.equal(result.model?.returned, 'deepseek-flash-fixture');
  assert.ok(!Object.hasOwn(result, 'withheldClaims'));
  assert.deepEqual(result.claims, [{
    status: 'insufficient',
    scope: 'selected-comparison',
    text: 'The model’s findings did not pass evidence checks. The selected records remain available for inspection.',
    citationIds: [],
    measurements: [],
  }]);
  assert.ok(!JSON.stringify(result).includes(rejectedText));
}

test('returns an inconclusive explanation for either contradictory provider status', async () => {
  const gap = { status: 'insufficient', text: 'Oxygen was unreported.', citationIds: ['fixture-gap'] };
  const quantityClaim = { ...reported, text: 'The chamber pressure was 90 kPa.' };
  for (const output of [
    { status: 'supported', claims: [gap] },
    { status: 'insufficient', claims: [reported] },
    { status: 'supported', claims: [{ ...gap, text: 'The records do not establish that oxygen was 99%.' }] },
    { status: 'insufficient', claims: [quantityClaim] },
  ]) {
    const result = await explainEvidence('What was recorded?', packet, fixture(output));
    assert.equal(result.status, 'insufficient');
    assert.equal(result.model?.configVersion, 'deepseek-7');
    assert.equal(result.model?.promptVersion, 'evidence-3');
    assert.deepEqual(result.provenance, { kind: 'deterministic-evidence', ruleVersion: 'status-conflict-1' });
    assert.ok(!Object.hasOwn(result, 'withheldClaims'));
    assert.deepEqual(result.claims, [{
      status: 'insufficient',
      scope: 'selected-comparison',
      text: 'The model returned inconsistent evidence statuses, so this explanation is inconclusive.',
      citationIds: [],
      measurements: [],
    }]);
  }

  for (const claim of [
    { ...quantityClaim, citationIds: ['unknown-id'] },
    { ...quantityClaim, extra: true },
  ]) {
    await assert.rejects(explainEvidence('What was recorded?', packet,
      fixture({ status: 'insufficient', claims: [claim] })), errorCode('invalid-response'));
  }
});

test('returns deterministic insufficiency when the packet contains only unknown evidence', async () => {
  const result = await explainEvidence('What is known?', { ...packet, evidence: [packet.evidence[2]] },
    { env, fetchImpl: neverFetch });
  assert.equal(result.status, 'insufficient');
  assert.equal(result.model, null);
  assert.deepEqual(result.claims[0].measurements, []);
});

test('allows standalone FLEX gas formulas while retaining quantity and citation checks', async () => {
  const gasPacket: DeepSeekEvidencePacket = {
    scope: 'selected-comparison',
    evidence: [{
      id: 'fixture-gas',
      status: 'reported',
      text: 'Synthetic record of oxygen, nitrogen and carbon dioxide.',
      numbers: [{ label: 'Oxygen mole fraction', value: 0.21, unit: 'mole fraction' }],
    }],
  };
  const gasClaim = { status: 'reported', citationIds: ['fixture-gas'] };
  const reply = (text: string, citationIds = gasClaim.citationIds) =>
    fixture({ status: 'supported', claims: [{ ...gasClaim, text, citationIds }] });
  for (const text of ['The record lists O₂, N₂, and CO₂.', 'The record lists O2, N2, and CO2.']) {
    const result = await explainEvidence('Which gases were recorded?', gasPacket, reply(text));
    assert.equal(result.claims[0].text, text);
    assert.equal(result.claims[0].measurements[0].value, 0.21);
  }
  for (const text of [
    'O₂ was 21%.',
    'CO2 was twenty percent.',
    'N₂ was ７９ percent.',
    'The record reports 2CO₂.',
    'The record reports CO₂₅.',
    'The record reports CO2.5.',
    'The record reports XO2.',
    'The record reports CO2_extra.',
  ]) {
    assertQuantityFallback(await explainEvidence('Which gases were recorded?', gasPacket, reply(text)), text);
  }
  await assert.rejects(explainEvidence('Which gases were recorded?', gasPacket, reply('The record lists CO₂.',
    ['fixture-other'])), errorCode('invalid-response'));
});

test('permits only exact selected FLEX identifiers in otherwise validated claims', async () => {
  const answer = (text: string, citationIds = reported.citationIds) => ({
    ...fixture({ status: 'supported', claims: [{ ...reported, text, citationIds }] }),
    selectedRunIds: ['FLEX-004', 'FLEX-005'],
  });
  const text = 'The records report chamber pressure for FLEX-004 and FLEX-005.';
  const result = await explainEvidence('What was recorded?', packet, answer(text));
  assert.equal(result.claims[0].text, text);
  for (const invalid of [
    'The records report chamber pressure for FLEX-001.',
    'The records report chamber pressure for flex-004.',
    'The records report chamber pressure for FLEX-0040.',
    'The records report chamber pressure for X_FLEX-004.',
    'The records report chamber pressure for FLEX-004-A.',
    'The records report chamber pressure for PRE-FLEX-004.',
    'The records report chamber pressure for FLEX-004–A.',
    'The records report chamber pressure for PRE−FLEX-004.',
    'FLEX-004 had a pressure of 90 kPa.',
    'FLEX-004 had a pressure of ninety kilopascals.',
  ]) {
    assertQuantityFallback(await explainEvidence('What was recorded?', packet, answer(invalid)), invalid);
  }
  await assert.rejects(explainEvidence('What was recorded?', packet, answer(text, ['unknown-id'])),
    errorCode('invalid-response'));
});

test('withholds verbal ratios while preserving qualitative comparisons and word boundaries', async () => {
  const equalPressure: DeepSeekEvidencePacket = {
    scope: 'selected-comparison',
    evidence: [{
      id: 'field:2',
      status: 'reported',
      text: 'Fixture ambient pressure. FLEX-004 and FLEX-005 each report 760 mmHg. Instrument notes use the labels doublet and triplex.',
      numbers: ['FLEX-004', 'FLEX-005'].map((id) => ({
        label: `Ambient pressure (${id})`, value: 760, unit: 'mmHg',
      })),
    }],
  };
  const question = 'How do the ambient pressures compare?';
  const answer = (text: string, citationIds = ['field:2']) => ({
    ...fixture({ status: 'supported', claims: [{ status: 'reported', text, citationIds }] }),
    selectedRunIds: ['FLEX-004', 'FLEX-005'],
  });
  for (const text of [
    'The chamber pressure in FLEX-004 was double that in FLEX-005.',
    'The chamber pressure tripled.',
    'The pressure was quadrupling.',
    'The pressure increased twofold.',
    'The pressure increased a dozen times.',
    'The pressure was ｄｏｕｂｌｅ.',
  ]) {
    assertQuantityFallback(await explainEvidence(question, equalPressure, answer(text)), text);
  }
  for (const text of [
    'The recorded chamber pressures match for FLEX-004 and FLEX-005.',
    'The instrument notes use the labels doublet and triplex.',
  ]) {
    const result = await explainEvidence(question, equalPressure, answer(text));
    assert.equal(result.status, 'supported');
    assert.equal(result.claims[0].text, text);
    assert.deepEqual(result.claims[0].measurements.map(({ value }) => value), [760, 760]);
  }
  await assert.rejects(explainEvidence(question, equalPressure, answer('The chamber pressure tripled.', ['unknown'])),
    errorCode('invalid-response'));
});

test('rejects invalid or oversized input before sending any request', async () => {
  const options = { env, fetchImpl: neverFetch };
  await assert.rejects(suggestFilters('', fields, options), errorCode('invalid-input'));
  await assert.rejects(suggestFilters(fixtureKey, fields, options), errorCode('invalid-input'));
  const largeField = Array<string>(100).fill('界'.repeat(120));
  await assert.rejects(suggestFilters('Fuel?', { fuel: largeField }, options), errorCode('invalid-input'));
  await assert.rejects(explainEvidence('Pressure?', { ...packet, evidence: [packet.evidence[0], packet.evidence[0]] },
    options), errorCode('invalid-input'));
  await assert.rejects(explainEvidence('Pressure?', { ...packet, evidence: new Array(1) },
    options), errorCode('invalid-input'));
});

test('checks the enable switch, credentials, official base URL and timeout before sending', async () => {
  await assert.rejects(suggestFilters('Fuel?', fields, { env: {}, fetchImpl: neverFetch }), errorCode('disabled'));
  for (const overrides of [
    { DEEPSEEK_API_KEY: '' },
    { DEEPSEEK_API_KEY: 'fixture\r\nkey' },
    { DEEPSEEK_BASE_URL: 'https://api.deepseek.com.example.org' },
    { DEEPSEEK_TIMEOUT_MS: '30001' },
    { DEEPSEEK_MODEL: 'other-model' },
  ]) {
    await assert.rejects(suggestFilters('Fuel?', fields, {
      env: { ...env, ...overrides }, fetchImpl: neverFetch,
    }), errorCode('not-configured'));
  }
});

test('handles authentication, balance, rate limit and service failures without retrying or relaying bodies', async () => {
  for (const [status, code] of [
    [401, 'authentication'], [403, 'authentication'], [402, 'insufficient-balance'], [429, 'rate-limit'],
    [503, 'service'],
  ] as const) {
    let calls = 0;
    await assert.rejects(suggestFilters('Fuel?', fields, { env, fetchImpl: async () => {
      calls++;
      return new Response(fixtureKey, { status });
    } }), errorCode(code, status));
    assert.equal(calls, 1);
  }
  await assert.rejects(suggestFilters('Fuel?', fields, { env, fetchImpl: async () => {
    throw new Error(fixtureKey);
  } }), errorCode('network'));
});

test('rejects blank, invalid, fenced, truncated and oversized responses', async () => {
  for (const [fetchImpl, code] of [
    [async () => response(null), 'invalid-response'],
    [async () => response('   '), 'invalid-response'],
    [async () => response('{'), 'invalid-response'],
    [async () => response('```json\n{"filters":{}}\n```'), 'invalid-response'],
    [async () => new Response('not an envelope'), 'invalid-response'],
    [async () => response('{"filters":{}}', 'length'), 'truncated'],
    [async () => response(null, 'insufficient_system_resource'), 'service'],
    [async () => new Response('x'.repeat(64 * 1024 + 1)), 'invalid-response'],
  ] as const) {
    await assert.rejects(suggestFilters('Fuel?', fields, { env, fetchImpl }), errorCode(code));
  }
});

test('times out during body reads and handles cancellation without retrying', async () => {
  let calls = 0;
  const keepTestActive = setInterval(() => undefined, 100);
  try {
    await assert.rejects(suggestFilters('Fuel?', fields, {
      env: { ...env, DEEPSEEK_TIMEOUT_MS: '10' },
      fetchImpl: async (_url, init) => {
        calls++;
        return new Response(new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
          },
        }));
      },
    }), errorCode('timeout'));
    assert.equal(calls, 1);
  } finally {
    clearInterval(keepTestActive);
  }

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(suggestFilters('Fuel?', fields, { env, signal: controller.signal, fetchImpl: neverFetch }),
    errorCode('aborted'));
});
