type Environment = Readonly<Record<string, string | undefined>>;
type Reservation = 'reserved' | 'exhausted' | 'unavailable';

const COUNTER_KEY = 'fire-evidence-explorer:deepseek:remaining-attempts';
const RESERVATION_TIMEOUT_MS = 2000;

// Return a permit only after Redis has atomically decremented the existing counter.
const RESERVE = `
local remaining = redis.call("GET", KEYS[1])
if remaining == "0" then return 0 end
if not remaining or not string.match(remaining, "^[1-9][0-9]*$") then return -1 end
redis.call("DECR", KEYS[1])
return 1
`.trim();

export function requiresDeepSeekBudget(env: Environment): boolean {
  return env.DEEPSEEK_REQUIRE_ATTEMPT_BUDGET === 'true'
    || env.VERCEL_ENV === 'preview'
    || env.VERCEL_ENV === 'production'
    || env.VERCEL_TARGET_ENV === 'preview'
    || env.VERCEL_TARGET_ENV === 'production'
    || (env.VERCEL === '1' && env.VERCEL_ENV !== 'development');
}

export async function reserveDeepSeekAttempt(
  env: Environment,
  fetchImpl: typeof fetch,
  callerSignal?: AbortSignal,
): Promise<Reservation> {
  const explicitUrl = env.UPSTASH_REDIS_REST_URL?.trim();
  const explicitToken = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  // An incomplete explicit pair fails validation even if native credentials are present.
  const useExplicit = Boolean(explicitUrl || explicitToken);
  const url = useExplicit ? explicitUrl : env.KV_REST_API_URL?.trim();
  const token = useExplicit ? explicitToken : env.KV_REST_API_TOKEN?.trim();
  if (!url || !/^https:\/\/[a-z0-9-]+\.upstash\.io\/?$/i.test(url)
    || !token || !/^[A-Za-z0-9._~+/=-]+$/.test(token) || callerSignal?.aborted) {
    return 'unavailable';
  }

  const timeout = AbortSignal.timeout(RESERVATION_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(['EVAL', RESERVE, 1, COUNTER_KEY]),
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return 'unavailable';
    }
    const payload: unknown = await response.json();
    if (!signal.aborted && payload && typeof payload === 'object'
      && 'result' in payload && !('error' in payload)) {
      if (payload.result === 1) return 'reserved';
      if (payload.result === 0) return 'exhausted';
    }
  } catch {
    // The decrement may already have taken effect. Never retry or credit it here.
  }
  return 'unavailable';
}
