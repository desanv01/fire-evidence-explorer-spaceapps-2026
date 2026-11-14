import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeepSeekError, explainEvidence, type DeepSeekEvidencePacket } from '../src/lib/deepseek.ts';

const env = { DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'fixture-credential-marker' };
const prompt = 'Fixture private question marker';
const packet: DeepSeekEvidencePacket = {
  scope: 'selected-comparison',
  evidence: [{ id: 'fixture-pressure', status: 'reported', text: 'Synthetic chamber pressure observation.' }],
};
const claim = { status: 'reported', text: 'The chamber pressures differ.', citationIds: ['fixture-pressure'] };

function wrapped(content: string | null, finishReason = 'stop') {
  return Response.json({
    model: 'fixture-raw-model-marker',
    choices: [{ finish_reason: finishReason, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 },
  });
}

const explanation = (value: unknown) => wrapped(JSON.stringify({ status: 'supported', claims: [value] }));

test('reports redacted failure stages with existing error codes', async (context) => {
  const warning = context.mock.method(console, 'warn', () => undefined);
  for (const [stage, response, finishReason, code] of [
    ['envelope-json', new Response('fixture-private-envelope'), null, 'invalid-response'],
    ['finish-reason', wrapped(null, 'fixture-private-finish-reason'), null, 'invalid-response'],
    ['finish-reason', wrapped(null, 'length'), 'length', 'truncated'],
    ['blank-content', wrapped('  '), 'stop', 'invalid-response'],
    ['content-json', wrapped('fixture-private-output'), 'stop', 'invalid-response'],
    ['credential-marker', wrapped(env.DEEPSEEK_API_KEY), 'stop', 'invalid-response'],
    ['claim-quantity-run-id', explanation({ ...claim, text: 'Pressure was recorded for FLEX-001.' }), 'stop', null],
    ['claim-quantity-prose-digits', explanation({ ...claim, text: 'Pressure was 90 mmHg.' }), 'stop', null],
    ['claim-quantity-number-words', explanation({ ...claim, text: 'Pressure was ninety millimeters of mercury.' }), 'stop', null],
    ['citation-membership', explanation({ ...claim, text: 'Pressure was 90 mmHg.', citationIds: ['fixture-unknown'] }), 'stop', 'invalid-response'],
    ['citation-membership', explanation({ ...claim, citationIds: ['fixture-unknown'] }), 'stop', 'invalid-response'],
    ['citation-count', explanation({
      ...claim, citationIds: ['fixture-pressure', 'fixture-a', 'fixture-b', 'fixture-c', 'fixture-d'],
    }), 'stop', 'invalid-response'],
    ['claim-status', explanation({ ...claim, status: 'derived' }), 'stop', 'invalid-response'],
  ] as const) {
    warning.mock.resetCalls();
    const result = explainEvidence(prompt, packet, {
      env: { ...env, DEEPSEEK_VALIDATION_DIAGNOSTICS: 'true' },
      fetchImpl: async () => response,
    });
    if (code) {
      await assert.rejects(result, (error) => error instanceof DeepSeekError && error.code === code);
    } else {
      assert.equal((await result).provenance?.ruleVersion, 'claim-withholding-1');
    }
    assert.equal(warning.mock.callCount(), 1);
    assert.deepEqual(warning.mock.calls[0].arguments, [
      'DeepSeek response validation failed',
      { stage, finishReason, upstreamStatus: 200, promptVersion: 'evidence-3' },
    ]);
  }
});

test('diagnostics stay silent by default and on accepted responses', async (context) => {
  const warning = context.mock.method(console, 'warn', () => undefined);
  await assert.rejects(explainEvidence(prompt, packet, {
    env, fetchImpl: async () => wrapped('fixture-private-output'),
  }), (error) => error instanceof DeepSeekError && error.code === 'invalid-response');
  const result = await explainEvidence(prompt, packet, {
    env: { ...env, DEEPSEEK_VALIDATION_DIAGNOSTICS: 'true' },
    fetchImpl: async () => explanation(claim),
  });
  assert.deepEqual(result.claims[0].citationIds, ['fixture-pressure']);
  assert.equal(warning.mock.callCount(), 0);
});
