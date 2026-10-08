/**
 * api/transport.js
 * ---------------------------------------------------------------------------
 * The ONLY place in the frontend that touches `fetch`.
 *
 * Owns: base URL, JSON encoding, timeouts, abort, GET retries, and the
 * translation of every failure mode into an ApiError.
 *
 * Nothing above this layer may call fetch, and nothing above this layer
 * throws a plain Error.
 * ---------------------------------------------------------------------------
 */

import { API_ERROR, ApiError, fromResponse } from './errors';

export const API_BASE = (import.meta.env?.VITE_API_BASE || 'http://localhost:8000').replace(/\/+$/, '');

export const DEFAULT_TIMEOUT_MS = 20000;
export const AGENT_STEP_TIMEOUT_MS = 180000;
export const DEFAULT_GET_RETRIES = 2;
const RETRY_BACKOFF_MS = [300, 900];

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);

/**
 * @param {string} path        path beginning with '/', e.g. '/queries/abc/trace'
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object} [options.body]      JSON-serializable
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeout]   ms; 0 disables
 * @param {number} [options.retries]   GET only; default 2
 * @param {object} [options.query]     query params, undefined/null skipped
 * @returns {Promise<any>} parsed JSON
 * @throws {ApiError}
 */
export async function request(path, options = {}) {
  const {
    method = 'GET',
    body,
    signal: callerSignal,
    timeout = DEFAULT_TIMEOUT_MS,
    retries,
    query,
  } = options;

  const url = buildUrl(path, query);
  const maxRetries = retries ?? (IDEMPOTENT_METHODS.has(method) ? DEFAULT_GET_RETRIES : 0);

  let attempt = 0;
  let lastError = null;

  while (true) {
    attempt += 1;
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? headers() : { ...headers(), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: composeSignal(callerSignal, timeout),
      });

      if (!res.ok) {
        throw await fromResponse(res, { endpoint: path, method });
      }

      const data = await readJson(res);
      if (import.meta.env?.DEV) {
        console.debug(`[api] ${method} ${path} ${res.status} in ${Date.now() - started}ms`);
      }
      return data;
    } catch (err) {
      const apiError = normalizeThrown(err, { path, method, callerSignal, timeout });

      // Never retry a caller abort.
      const retryable =
        attempt <= maxRetries &&
        (apiError.code === API_ERROR.NETWORK || apiError.code === API_ERROR.SERVER) &&
        !apiError.isAborted;

      if (!retryable) {
        throw apiError;
      }

      lastError = apiError;
      await sleep(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]);

      // A caller abort that landed during the backoff must end the loop.
      if (callerSignal?.aborted) throw lastError;
    }
  }
}

function headers() {
  return { Accept: 'application/json' };
}

function buildUrl(path, query) {
  const url = new URL(`${API_BASE}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function composeSignal(callerSignal, timeout) {
  const signals = [];
  if (callerSignal) signals.push(callerSignal);
  if (timeout && timeout > 0 && typeof AbortSignal?.timeout === 'function') {
    signals.push(AbortSignal.timeout(timeout));
  }
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal?.any === 'function') return AbortSignal.any(signals);
  return callerSignal ?? signals[0];
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('Backend returned a non-JSON response.', {
      code: API_ERROR.SERVER,
      status: res.status,
      body: text.slice(0, 400),
    });
  }
}

function normalizeThrown(err, { path, method, callerSignal, timeout }) {
  if (err instanceof ApiError) {
    return new ApiError(err.message, {
      code: err.code,
      status: err.status,
      detail: err.detail,
      fields: err.fields,
      endpoint: err.endpoint ?? path,
      method: err.method ?? method,
      body: err.body,
      cause: err.cause,
    });
  }

  const timedOut =
    !callerSignal?.aborted &&
    (err?.name === 'TimeoutError' || (err?.name === 'AbortError' && timeout > 0));
  const aborted = timedOut || err?.name === 'AbortError' || callerSignal?.aborted;
  if (aborted) {
    return new ApiError(
      timedOut ? `Request timed out after ${timeout}ms.` : 'Request cancelled.',
      { code: timedOut ? API_ERROR.TIMEOUT : API_ERROR.ABORTED, endpoint: path, method, cause: err },
    );
  }

  // fetch() rejects with TypeError on DNS failure, port closed, CORS, offline.
  return new ApiError(
    `Backend unreachable at ${API_BASE}. Start it with ".\\.venv\\Scripts\\python.exe -m uvicorn main:app --app-dir Backend --port 8000".`,
    {
      code: API_ERROR.BACKEND_OFFLINE,
      status: 0,
      endpoint: path,
      method,
      cause: err,
    },
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
