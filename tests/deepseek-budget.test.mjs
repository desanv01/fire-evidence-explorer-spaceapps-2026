import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeepSeekError, explainEvidence, suggestFilters } from '../src/lib/deepseek.ts';

const redisUrl = 'https://fixture-instance.upstash.io';
const providerUrl = 'https://api.deepseek.com/chat/completions';
const counterKey = 'fire-evidence-explorer:deepseek:remaining-attempts';
const local = { DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'fixture-provider-key' };
const hosted = {
  ...local,
  VERCEL_ENV: 'preview',
  UPSTASH_REDIS_REST_URL: redisUrl,
  UPSTASH_REDIS_REST_TOKEN: 'fixture-redis-token',
};
const fields = { fuel: ['Methanol'] };
const packet = { scope: 'selected-comparison', evidence: [{
  id: 'field:2', status: 'reported', text: 'The fixture records chamber pressure.',
}] };
const propose = (options) => suggestFilters('Which fuel?', fields, options);
const explain = (options) => explainEvidence('Which pressure?', packet, options);
const isError = (code) => (error) => error instanceof DeepSeekError && error.code === code;

function providerResponse(init) {
  const request = JSON.parse(init.body);
  const content = request.max_tokens === 400 ? { filters: { fuel: 'Methanol' } } : {
    status: 'supported', claims: [{
      status: 'reported', text: 'The fixture records chamber pressure.', citationIds: ['field:2'],
    }],
  };
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-provider-key');
  assert.equal(request.model, 'deepseek-flash');
  return Response.json({ choices: [{
    finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) },
  }] });
}

function checkReservationRequest(init) {
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.cache, 'no-store');
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-redis-token');
  const [operation, script, keyCount, key] = JSON.parse(init.body);
  assert.deepEqual([operation, keyCount, key], ['EVAL', 1, counterKey]);
  assert.match(script, /redis.call\("GET", KEYS\[1\]\)/);
  assert.match(script, /redis.call\("DECR", KEYS\[1\]\)/);
  assert.ok(!init.body.includes('fixture-provider-key'));
  assert.ok(!init.body.includes('Which pressure?'));
}

test('one shared allowance covers simultaneous proposals and explanations across environments', async () => {
  let remaining = 2;
  const operations = [];
  const workerTransport = () => async (url, init) => {
    if (url === redisUrl) {
      checkReservationRequest(init);
      operations.push('reserve');
      // Fake the atomic store with a synchronous decrement shared by the workers.
      if (!remaining) return Response.json({ result: 0 });
      remaining--;
      return Response.json({ result: 1 });
    }
    assert.equal(url, providerUrl);
    operations.push('provider');
    return providerResponse(init);
  };
  const preview = { env: hosted, fetchImpl: workerTransport() };
  const production = { env: { ...hosted, VERCEL_ENV: 'production' }, fetchImpl: workerTransport() };
  const results = await Promise.allSettled([
    propose(preview), explain(production), explain(preview), propose(production),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 2);
  assert.equal(results.filter(({ status, reason }) => status === 'rejected' && isError('rate-limit')(reason)).length, 2);
  assert.equal(operations.filter((operation) => operation === 'reserve').length, 4);
  assert.equal(operations.filter((operation) => operation === 'provider').length, 2);
  assert.equal(remaining, 0);
});

test('fails closed for missing hosted configuration or unpinned model before transport', async () => {
  const fetchImpl = async () => assert.fail('Transport must remain unused');
  for (const env of [
    { ...local, VERCEL: '1' },
    { ...local, VERCEL_ENV: 'production' },
    { ...local, VERCEL_TARGET_ENV: 'preview' },
    { ...local, DEEPSEEK_REQUIRE_ATTEMPT_BUDGET: 'true' },
    { ...hosted, UPSTASH_REDIS_REST_URL: 'https://fixture-instance.upstash.io.example.org' },
    { ...hosted, UPSTASH_REDIS_REST_TOKEN: '' },
    { ...hosted, DEEPSEEK_MODEL: 'deepseek-v4-pro' },
  ]) {
    await assert.rejects(propose({ env, fetchImpl }), isError('not-configured'));
  }
  await assert.rejects(propose({ env: { ...hosted, DEEPSEEK_ENABLED: 'false' }, fetchImpl }), isError('disabled'));
  await assert.rejects(suggestFilters('', fields, { env: hosted, fetchImpl }), isError('invalid-input'));
});

test('blocks the provider on missing, invalid, unavailable or ambiguous counter responses', async () => {
  for (const reserve of [
    () => Response.json({ result: -1 }),
    () => Response.json({ result: '1' }),
    () => Response.json({ result: 1, error: 'fixture-store-error' }),
    () => new Response('non-JSON'),
    () => new Response(null, { status: 503 }),
    () => { throw new Error('A decrement may already have occurred'); },
  ]) {
    let attempts = 0;
    await assert.rejects(explain({ env: hosted, fetchImpl: async (url) => {
      attempts++;
      assert.equal(url, redisUrl);
      return reserve();
    } }), isError('not-configured'));
    assert.equal(attempts, 1);
  }
});

test('uses the native write pair only when explicit Upstash settings are blank', async () => {
  const nativeUrl = 'https://fixture-native.upstash.io';
  const native = {
    ...hosted,
    UPSTASH_REDIS_REST_URL: '',
    UPSTASH_REDIS_REST_TOKEN: ' ',
    KV_REST_API_URL: nativeUrl,
    KV_REST_API_TOKEN: 'fixture-native-write',
    KV_REST_API_READ_ONLY_TOKEN: 'fixture-native-read',
  };
  for (const [env, expectedUrl, expectedToken] of [
    [native, nativeUrl, 'fixture-native-write'],
    [{ ...native, ...hosted }, redisUrl, 'fixture-redis-token'],
  ]) {
    const urls = [];
    const result = await propose({ env, fetchImpl: async (url, init) => {
      urls.push(url);
      if (url === providerUrl) return providerResponse(init);
      assert.equal(url, expectedUrl);
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${expectedToken}`);
      return Response.json({ result: 1 });
    } });
    assert.deepEqual(urls, [expectedUrl, providerUrl]);
    assert.deepEqual(result.filters, { fuel: 'Methanol' });
  }
});

test('rejects partial, mixed, read-only and invalid explicit budget settings', async () => {
  const native = {
    ...local,
    VERCEL_ENV: 'production',
    KV_REST_API_URL: 'https://fixture-native.upstash.io',
    KV_REST_API_TOKEN: 'fixture-native-write',
    KV_REST_API_READ_ONLY_TOKEN: 'fixture-native-read',
  };
  for (const env of [
    { ...native, UPSTASH_REDIS_REST_URL: redisUrl },
    { ...native, UPSTASH_REDIS_REST_TOKEN: 'fixture-redis-token' },
    { ...native, KV_REST_API_URL: '' },
    { ...native, KV_REST_API_TOKEN: '' },
    { ...native, ...hosted, UPSTASH_REDIS_REST_URL: 'https://fixture.upstash.io.example.org' },
  ]) {
    await assert.rejects(propose({
      env, fetchImpl: async () => assert.fail('Transport must remain unused'),
    }), isError('not-configured'));
  }
});

test('keeps reservations consumed after cancelled and ambiguous provider attempts', async () => {
  const controller = new AbortController();
  let balance = 2;
  let providerAttempts = 0;
  const fetchImpl = async (url) => {
    if (url === redisUrl) {
      if (!balance) return Response.json({ result: 0 });
      if (--balance === 1) controller.abort();
      return Response.json({ result: 1 });
    }
    assert.equal(url, providerUrl);
    providerAttempts++;
    throw new Error('The provider may have received this request');
  };
  await assert.rejects(explain({ env: hosted, fetchImpl, signal: controller.signal }), isError('aborted'));
  assert.equal(providerAttempts, 0);
  await assert.rejects(explain({ env: hosted, fetchImpl }), isError('network'));
  await assert.rejects(propose({ env: hosted, fetchImpl }), isError('rate-limit'));
  assert.equal(providerAttempts, 1);
  assert.equal(balance, 0);
});

test('preserves local fixture behavior without a hosted reservation', async () => {
  const result = await propose({ env: local, fetchImpl: async (url, init) => {
    assert.equal(url, providerUrl);
    return providerResponse(init);
  } });
  assert.deepEqual(result.filters, { fuel: 'Methanol' });
});
