import { describe, it, expect } from 'vitest';
import { API_ERROR, ApiError, fromResponse, parseErrorBody, statusToCode } from './errors';
import body422 from '../fixtures/api/error.422.json';
import body404 from '../fixtures/api/error.404.json';

function fakeResponse(status, body, { statusText = 'Error', json = true } = {}) {
  return {
    ok: false,
    status,
    statusText,
    json: async () => (json ? body : undefined),
  };
}

describe('statusToCode', () => {
  it('maps the codes this backend actually returns', () => {
    expect(statusToCode(0)).toBe(API_ERROR.NETWORK);
    expect(statusToCode(400)).toBe(API_ERROR.BAD_REQUEST);
    expect(statusToCode(404)).toBe(API_ERROR.NOT_FOUND);
    expect(statusToCode(405)).toBe(API_ERROR.UNSUPPORTED);
    expect(statusToCode(422)).toBe(API_ERROR.UNPROCESSABLE);
    expect(statusToCode(500)).toBe(API_ERROR.SERVER);
    expect(statusToCode(503)).toBe(API_ERROR.SERVER);
  });

  it('reads a 404 on the session collection as "endpoint not implemented"', () => {
    expect(statusToCode(404, '/queries')).toBe(API_ERROR.UNSUPPORTED);
    expect(statusToCode(404, '/queries/abc/trace')).toBe(API_ERROR.NOT_FOUND);
    expect(statusToCode(404, '/queries/abc/checkpoints')).toBe(API_ERROR.NOT_FOUND);
  });
});

describe('parseErrorBody', () => {
  it('handles the plain string detail form', () => {
    const { message, fields } = parseErrorBody(body404, 'fallback');
    expect(message).toBe('Query session or checkpoint not found.');
    expect(fields).toEqual([]);
  });

  it('turns a FastAPI 422 issue list into a readable message and field names', () => {
    const { message, fields } = parseErrorBody(body422, 'fallback');
    expect(message).toBe('parameters: Input should be a valid dictionary');
    expect(fields).toEqual(['parameters']);
  });

  it('joins multiple 422 issues', () => {
    const { message, fields } = parseErrorBody(
      {
        detail: [
          { type: 'missing', loc: ['body', 'action_type'], msg: 'Field required' },
          { type: 'string_type', loc: ['body', 'parameters', 'column'], msg: 'Input should be a valid string' },
        ],
      },
      'fallback',
    );
    expect(message).toContain('action_type: Field required');
    expect(message).toContain('parameters.column: Input should be a valid string');
    expect(fields).toEqual(['action_type', 'column']);
  });

  it('falls back when the body is not a FastAPI error at all', () => {
    expect(parseErrorBody(null, 'Request failed').message).toBe('Request failed');
    expect(parseErrorBody({ message: 'gateway timeout' }, 'fb').message).toBe('gateway timeout');
    expect(parseErrorBody('not json', 'fb').message).toBe('not json');
  });
});

describe('fromResponse', () => {
  it('produces an ApiError carrying status, detail and fields', async () => {
    const err = await fromResponse(fakeResponse(422, body422), { endpoint: '/queries/x/actions', method: 'POST' });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(API_ERROR.UNPROCESSABLE);
    expect(err.status).toBe(422);
    expect(err.fields).toEqual(['parameters']);
    expect(err.endpoint).toBe('/queries/x/actions');
    expect(err.method).toBe('POST');
    expect(err.isUserFixable).toBe(true);
    expect(err.isOffline).toBe(false);
  });

  it('survives a non-JSON error body', async () => {
    const res = fakeResponse(502, undefined, { statusText: 'Bad Gateway', json: false });
    res.json = async () => {
      throw new Error('not json');
    };
    const err = await fromResponse(res, { endpoint: '/queries', method: 'POST' });
    expect(err.code).toBe(API_ERROR.SERVER);
    expect(err.message).toContain('502');
  });

  it('classifies a missing checkpoint as NOT_FOUND, not UNSUPPORTED', async () => {
    const err = await fromResponse(fakeResponse(404, body404), { endpoint: '/queries/x/recover', method: 'POST' });
    expect(err.code).toBe(API_ERROR.NOT_FOUND);
    expect(err.message).toBe('Query session or checkpoint not found.');
  });
});

describe('ApiError', () => {
  it('names cancellation separately from failure', () => {
    const aborted = new ApiError('Request cancelled.', { code: API_ERROR.ABORTED });
    expect(aborted.isAborted).toBe(true);
    expect(aborted.isUserFixable).toBe(false);
    expect(aborted.isOffline).toBe(false);
  });

  it('flags an unimplemented endpoint', () => {
    expect(new ApiError('nope', { code: API_ERROR.UNSUPPORTED }).isUnsupported).toBe(true);
  });

  it('defaults to a network failure', () => {
    const err = new ApiError('boom');
    expect(err.code).toBe(API_ERROR.NETWORK);
    expect(err.status).toBe(0);
    expect(err.isOffline).toBe(true);
    expect(err.name).toBe('ApiError');
  });
});
