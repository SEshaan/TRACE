/**
 * api/errors.js
 * ---------------------------------------------------------------------------
 * The only error type the data layer throws.
 *
 * FastAPI errors are not strings: a 422 body is
 *   { "detail": [ { "loc": ["body","parameters"], "msg": "...", "type": "..." } ] }
 * so `new Error(detail || 'fallback')` renders "[object Object]" in the UI.
 * ApiError keeps status, a readable message, and the offending field names.
 * ---------------------------------------------------------------------------
 */

export const API_ERROR = {
  /** No connection at all (server down, port closed, CORS). */
  BACKEND_OFFLINE: 'BACKEND_OFFLINE',
  /** Request never completed. */
  NETWORK: 'NETWORK',
  /** transport timeout hit. */
  TIMEOUT: 'TIMEOUT',
  /** Caller aborted (run cancelled, component unmounted). */
  ABORTED: 'ABORTED',
  /** 404 — session / checkpoint id does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** 400 — backend ValueError / unsupported action_type. */
  BAD_REQUEST: 'BAD_REQUEST',
  /** 422 — pydantic rejected the body shape. */
  UNPROCESSABLE: 'UNPROCESSABLE',
  /** 5xx. */
  SERVER: 'SERVER',
  /** Endpoint exists in the frontend plan but not in this backend build. */
  UNSUPPORTED: 'UNSUPPORTED',
  /** Local: caller asked to recover without a usable checkpoint. */
  NO_CHECKPOINT: 'NO_CHECKPOINT',
  /** Local: action type is not in the backend vocabulary. */
  INVALID_ACTION: 'INVALID_ACTION',
  /** Local: required parameter missing / malformed before the request. */
  PREFLIGHT: 'PREFLIGHT',
};

export class ApiError extends Error {
  constructor(message, { code, status, detail, fields, endpoint, method, body, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code ?? API_ERROR.NETWORK;
    this.status = status ?? 0;
    this.detail = detail ?? message;
    this.fields = fields ?? [];
    this.endpoint = endpoint ?? null;
    this.method = method ?? null;
    this.body = body ?? null;
    if (cause) this.cause = cause;
  }

  /** Backend is unreachable — show the "start the backend" affordance. */
  get isOffline() {
    return this.code === API_ERROR.BACKEND_OFFLINE || this.code === API_ERROR.NETWORK;
  }

  /** Caller-initiated cancellation — never surface as an error toast. */
  get isAborted() {
    return this.code === API_ERROR.ABORTED;
  }

  /** The user can fix this in a form. */
  get isUserFixable() {
    return (
      this.code === API_ERROR.BAD_REQUEST ||
      this.code === API_ERROR.UNPROCESSABLE ||
      this.code === API_ERROR.PREFLIGHT ||
      this.code === API_ERROR.INVALID_ACTION ||
      this.code === API_ERROR.NO_CHECKPOINT
    );
  }

  /** The endpoint is not implemented in this backend build. */
  get isUnsupported() {
    return this.code === API_ERROR.UNSUPPORTED;
  }
}

export function statusToCode(status, endpoint = '') {
  if (status === 0) return API_ERROR.NETWORK;
  if (status === 404) {
    // A 404 on a collection route means "not implemented in this build".
    return endpoint.replace(/\/+$/, '') === '/queries' ? API_ERROR.UNSUPPORTED : API_ERROR.NOT_FOUND;
  }
  if (status === 405) return API_ERROR.UNSUPPORTED;
  if (status === 400) return API_ERROR.BAD_REQUEST;
  if (status === 422) return API_ERROR.UNPROCESSABLE;
  if (status >= 500) return API_ERROR.SERVER;
  return API_ERROR.SERVER;
}

/**
 * Turn a FastAPI error body into { message, detail, fields }.
 * Handles both the string form and the 422 array-of-issues form.
 */
export function parseErrorBody(body, fallbackMessage) {
  // A bare string body (proxy, gateway, plain HTTPException in older routes).
  if (typeof body === 'string') {
    const text = body.trim();
    return { message: text || fallbackMessage, detail: text, fields: [] };
  }

  const detail = body?.detail;

  if (typeof detail === 'string') {
    return { message: detail, detail, fields: [] };
  }

  if (Array.isArray(detail)) {
    const fields = detail
      .map((issue) => (Array.isArray(issue?.loc) ? issue.loc[issue.loc.length - 1] : null))
      .filter(Boolean)
      .map(String);

    const message =
      detail
        .map((issue) => {
          const where = Array.isArray(issue?.loc) ? issue.loc.slice(1).join('.') : '';
          const msg = issue?.msg ?? 'invalid value';
          return where ? `${where}: ${msg}` : msg;
        })
        .join('; ') || fallbackMessage;

    return { message, detail, fields };
  }

  return {
    message: body?.message ?? fallbackMessage,
    detail: detail ?? body ?? null,
    fields: [],
  };
}

/**
 * Build an ApiError from a non-ok Response. Never throws.
 */
export async function fromResponse(res, { endpoint, method } = {}) {
  const fallback = `Request failed (${res.status} ${res.statusText})`;
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }

  const { message, detail, fields } = parseErrorBody(body, fallback);
  const code = statusToCode(res.status, endpoint);

  return new ApiError(message, { code, status: res.status, detail, fields, endpoint, method, body });
}
