/**
 * api/transport.test.js — the only layer that touches fetch must own every
 * failure mode and translate them into ApiError before anything above sees a
 * plain Error. These tests drive `request()` with a per-attempt fetch mock so
 * retries, backoff, abort precedence and error classification are all observable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request, API_BASE, DEFAULT_GET_RETRIES } from './transport';
import { API_ERROR, ApiError } from './errors';

const calls = [];

function ok(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** A fetch mock that records every call and delegates to a responder (or defaults). */
function installFetch(responder) {
  global.fetch = vi.fn(async (url, init = {}) => {
    calls.push({ url, init });
    return global.__responder ? global.__responder({ url, init }) : ok({});
  });
}

beforeEach(() => {
  calls.length = 0;
  installFetch();
});

afterEach(() => {
  delete global.__responder;
  vi.restoreAllMocks();
});

describe('request — happy path', () => {
  it('returns parsed JSON and records the call', async () => {
    const body = { rows: [{ a: 1 }] };
    global.__responder = ({}) => ok(body);
    const data = await request('/queries/sess-1/trace');
    expect(data).toEqual(body);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://localhost:8000/queries/sess-1/trace');
  });

  it('builds query string params, skipping null/undefined/empty values', async () => {
    global.__responder = ({ url }) => ok({});
    await request('/queries/sess-1/schema', { query: { limit: 5, table: 'students' } });
    expect(calls[0].url).toContain('limit=5');
    expect(calls[0].url).toContain('table=students');
    // null and empty are dropped
    await request('/queries/sess-1/schema', { query: { skip: null, q: '' } });
    expect(calls[0].url).not.toContain('skip=');
    expect(calls[0].url).not.toContain('q=');
  });

  it('sets Content-Type only when a JSON body is sent', async () => {
    global.__responder = ({ init }) => ok({});
    await request('/queries/sess-1/actions', { method: 'POST', body: { action_type: 'LIMIT' } });
    const postInit = calls[calls.length - 1].init;
    expect(postInit.headers['Content-Type']).toBe('application/json');

    await request('/queries/sess-1/health'); // GET, no body
    const getInit = calls[calls.length - 1].init;
    expect(getInit.headers['Content-Type']).toBeUndefined();
    expect(getInit.headers.Accept).toBe('application/json');
  });
});

describe('request — retries and backoff (GET is idempotent)', () => {
  it('retries a GET on transient failure, then succeeds', async () => {
    const body = { ok: true };
    let attempts = 0;
    global.__responder = ({}) => {
      attempts += 1;
      if (attempts < 3) throw new ApiError('transient', { code: API_ERROR.NETWORK });
      return ok(body);
    };

    const data = await request('/queries/sess-1/trace');
    expect(data).toEqual(body);
    // initial attempt + DEFAULT_GET_RETRIES retries
    expect(calls).toHaveLength(3);
  });

  it('does not retry a non-idempotent POST on failure', async () => {
    let attempts = 0;
    global.__responder = ({}) => {
      attempts += 1;
      throw new ApiError('boom', { code: API_ERROR.NETWORK });
    };

    await expect(request('/queries/sess-1/actions', { method: 'POST', body: {} })).rejects.toMatchObject({
      code: API_ERROR.NETWORK,
    });
    // POST is never retried regardless of the idempotent set
    expect(calls).toHaveLength(1);
  });

  it('stops retrying once retries are exhausted', async () => {
    global.__responder = ({}) => {
      throw new ApiError('always down', { code: API_ERROR.NETWORK });
    };
    await expect(request('/queries/sess-1/trace')).rejects.toMatchObject({ code: API_ERROR.NETWORK });
    // 1 initial + DEFAULT_GET_RETRIES retries, then give up
    expect(calls).toHaveLength(DEFAULT_GET_RETRIES + 1);
  });

  it('honours an explicit retries override', async () => {
    let attempts = 0;
    global.__responder = ({}) => {
      attempts += 1;
      if (attempts < 2) throw new ApiError('x', { code: API_ERROR.NETWORK });
      return ok({ done: true });
    };
    const data = await request('/queries/sess-1/trace', { retries: 1 });
    expect(data).toEqual({ done: true });
    expect(calls).toHaveLength(2); // initial + 1 override retry
  });
});

describe('request — abort wins over retry', () => {
  it('never retries when the caller signal is already aborted (even for GET)', async () => {
    const controller = new AbortController();
    controller.abort();
    // A real network failure is a plain TypeError; an aborted caller turns it into ABORTED.
    global.__responder = ({}) => {
      throw new TypeError('network down');
    };

    await expect(
      request('/queries/sess-1/trace', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: API_ERROR.ABORTED });
    // A GET would normally retry, but the abort short-circuits it.
    expect(calls).toHaveLength(1);
  });

  it('ends immediately when the caller aborts during a request', async () => {
    const controller = new AbortController();
    global.__responder = ({}) => {
      controller.abort(); // abort mid-flight
      throw new TypeError('network down');
    };

    await expect(
      request('/queries/sess-1/trace', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: API_ERROR.ABORTED });
    // The abort during the first attempt prevents any retry.
    expect(calls).toHaveLength(1);
  });
});

describe('request — error classification', () => {
  it('classifies a raw TypeError as backend offline (isOffline)', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const err = await request('/queries/sess-1/trace').catch((e) => e);
    expect(err.code).toBe(API_ERROR.BACKEND_OFFLINE);
    expect(err.isOffline).toBe(true);
  });

  it('classifies a TimeoutError as TIMEOUT', async () => {
    // timeout: 0 so the abort-vs-timeout disambiguation doesn't mask it.
    global.fetch = vi.fn(async () => {
      throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    });
    const err = await request('/queries/sess-1/trace', { timeout: 0 }).catch((e) => e);
    // A timeout is classified as TIMEOUT (not ABORTED): it's not caller-initiated.
    expect(err.code).toBe(API_ERROR.TIMEOUT);
    expect(err.isAborted).toBe(false);
  });

  it('classifies an AbortError as ABORTED and not offline', async () => {
    // timeout: 0 so a positive default timeout can't reclassify this as TIMEOUT.
    global.fetch = vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    });
    const err = await request('/queries/sess-1/trace', { timeout: 0 }).catch((e) => e);
    expect(err.code).toBe(API_ERROR.ABORTED);
    expect(err.isOffline).toBe(false);
  });

  it('classifies a non-JSON success body as SERVER', async () => {
    global.__responder = ({}) => ({ ok: true, status: 200, text: async () => 'this is not json{' });
    const err = await request('/queries/sess-1/trace').catch((e) => e);
    expect(err.code).toBe(API_ERROR.SERVER);
    expect(err.message).toContain('non-JSON');
  });

  it('maps a 422 body into UNPROCESSABLE with field names', async () => {
    const body = { detail: [{ loc: ['body', 'parameters'], msg: 'invalid' }, { loc: ['body', 'value'], msg: 'bad' }] };
    global.__responder = ({}) => ({ ok: false, status: 422, json: async () => body, text: async () => JSON.stringify(body) });

    const err = await request('/queries/sess-1/actions', { method: 'POST', body: {} }).catch((e) => e);
    expect(err.code).toBe(API_ERROR.UNPROCESSABLE);
    expect(err.status).toBe(422);
    expect(Array.isArray(err.fields)).toBe(true);
    expect(err.fields).toContain('parameters');
    expect(err.fields).toContain('value');
  });

  it('maps a 404 on the /queries root to UNSUPPORTED, else NOT_FOUND', async () => {
    global.__responder = ({ url }) => ({ ok: false, status: 404, json: async () => {}, text: async () => '' });
    const err = await request('/queries').catch((e) => e);
    expect(err.code).toBe(API_ERROR.UNSUPPORTED);

    global.__responder = ({ url }) => ({ ok: false, status: 404, json: async () => {}, text: async () => '' });
    const err2 = await request('/queries/sess-1/trace').catch((e) => e);
    expect(err2.code).toBe(API_ERROR.NOT_FOUND);
  });
});

describe('API_BASE', () => {
  it('trims trailing slashes and defaults to localhost:8000', () => {
    expect(API_BASE).toBe('http://localhost:8000');
  });
});
