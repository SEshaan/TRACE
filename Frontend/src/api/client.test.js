import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  applyAction,
  createCheckpoint,
  createSession,
  getSession,
  getTrace,
  listSessions,
  recover,
} from './client';
import { API_ERROR } from './errors';
import body422 from '../fixtures/api/error.422.json';
import body404 from '../fixtures/api/error.404.json';
import fixtureTrace from '../fixtures/api/trace.recovered.json';
import fixtureApply from '../fixtures/api/applyAction.selectColumn.json';

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

function fail(status, body) {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body ?? ''),
  };
}

beforeEach(() => {
  calls.length = 0;
  global.fetch = vi.fn(async (url, init = {}) => {
    calls.push({ url, init });
    return global.__responder ? global.__responder({ url, init }) : ok({});
  });
});

afterEach(() => {
  delete global.__responder;
  vi.restoreAllMocks();
});

describe('requests that must never reach the network', () => {
  it('rejects an action type the backend does not implement', async () => {
    await expect(applyAction('sess-1', 'ADD_FILTER', { column: 'gpa', operator: '>', value: 8 })).rejects.toMatchObject({
      code: API_ERROR.INVALID_ACTION,
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects a string parameters payload (the 422 producer)', async () => {
    await expect(
      applyAction('sess-1', { action_type: 'FILTER', parameters: 'GPA > 8.5' }),
    ).rejects.toMatchObject({ code: API_ERROR.PREFLIGHT });
    expect(calls).toHaveLength(0);
  });

  it('refuses to recover with a fabricated checkpoint id', async () => {
    await expect(
      recover('sess-1', { checkpointId: 'cp-389b65', action: { action_type: 'FILTER', parameters: { column: 'gpa', operator: '>', value: 8.5 } } }),
    ).rejects.toMatchObject({ code: API_ERROR.NO_CHECKPOINT });
    expect(calls).toHaveLength(0);
  });

  it('refuses to recover with a state id passed as a checkpoint id', async () => {
    await expect(
      recover('sess-1', { checkpointId: null, action: { action_type: 'FILTER', parameters: { column: 'gpa', operator: '>', value: 8.5 } } }),
    ).rejects.toMatchObject({ code: API_ERROR.NO_CHECKPOINT });
    expect(calls).toHaveLength(0);
  });

  it('refuses an empty query request', async () => {
    await expect(createSession('   ')).rejects.toMatchObject({ code: API_ERROR.PREFLIGHT });
    expect(calls).toHaveLength(0);
  });

  it('refuses a missing session id', async () => {
    await expect(getSession(null)).rejects.toMatchObject({ code: API_ERROR.PREFLIGHT });
    expect(calls).toHaveLength(0);
  });
});

describe('transport -> ApiError mapping', () => {
  it('turns a FastAPI 422 into a usable, field-tagged error', async () => {
    global.__responder = () => fail(422, body422);
    await expect(
      applyAction('sess-1', { action_type: 'FILTER', parameters: { column: 'gpa', operator: '>', value: 8.5 } }),
    ).rejects.toMatchObject({
      code: API_ERROR.UNPROCESSABLE,
      status: 422,
      fields: ['parameters'],
      message: 'parameters: Input should be a valid dictionary',
    });
  });

  it('classifies a missing checkpoint as NOT_FOUND', async () => {
    global.__responder = () => fail(404, body404);
    await expect(
      recover('sess-1', { checkpointId: 'e7590711-0000-4000-8000-0000000000c4', action: { action_type: 'LIMIT', parameters: { limit: 5 } } }),
    ).rejects.toMatchObject({ code: API_ERROR.NOT_FOUND, status: 404 });
  });

  it('classifies an unreachable backend as BACKEND_OFFLINE', async () => {
    global.__responder = () => {
      throw Object.assign(new TypeError('fetch failed'), { name: 'TypeError' });
    };
    await expect(getTrace('sess-1', { retries: 0 })).rejects.toMatchObject({
      code: API_ERROR.BACKEND_OFFLINE,
      status: 0,
    });
  });

  it('reports an unimplemented list endpoint as unsupported, not as an error', async () => {
    global.__responder = () => fail(404, body404);
    await expect(listSessions()).resolves.toEqual({ items: [], unsupported: true });
  });
});

describe('successful responses are normalized', () => {
  it('maps an applied action into the DTO shape', async () => {
    global.__responder = () => ok(fixtureApply);
    const result = await applyAction('sess-1', { action_type: 'SELECT_COLUMN', parameters: { column: '*' } });

    expect(result.success).toBe(true);
    expect(result.state.preview.rowCount).toBe(8);
    expect(result.state.action.type).toBe('SELECT_COLUMN');
    expect(result.state.action.confidence).toBe(1);
    expect(result.state.row_count).toBe(8); // transition alias
    expect(result.failure).toBeNull();
    expect(result.raw).toEqual(fixtureApply);
  });

  it('sends the body the backend expects', async () => {
    global.__responder = () => ok(fixtureApply);
    await applyAction('sess-1', { action_type: 'FILTER', parameters: { column: 'gpa', operator: '>', value: 8.5 } });

    const body = JSON.parse(calls[0].init.body);
    expect(body).toEqual({ action_type: 'FILTER', parameters: { column: 'gpa', operator: '>', value: 8.5 } });
  });

  it('normalizes a full trace', async () => {
    global.__responder = () => ok(fixtureTrace);
    const trace = await getTrace('sess-1');
    expect(trace.states).toHaveLength(5);
    expect(trace.checkpoints[0].stateId).toBe('bafbad16-0000-4000-8000-000000000003');
    expect(trace.failures[0].stateId).toBeNull(); // backend does not send it yet
  });

  it('sends state_id when the caller asks to checkpoint a specific node', async () => {
    global.__responder = () => ok({ id: 'cp-1', state_id: 'state-9', label: 'base' });
    const checkpoint = await createCheckpoint('sess-1', { stateId: 'state-9', label: 'base' });

    expect(JSON.parse(calls[0].init.body)).toEqual({ label: 'base', state_id: 'state-9' });
    expect(checkpoint.pinnedToCurrentState).toBe(false);
  });

  it('retries without state_id when the backend rejects the unknown field', async () => {
    let attempt = 0;
    global.__responder = () => {
      attempt += 1;
      return attempt === 1 ? fail(422, body422) : ok({ id: 'cp-1', state_id: 'state-current', label: 'base' });
    };

    const checkpoint = await createCheckpoint('sess-1', { stateId: 'state-9', label: 'base' });

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].init.body)).toEqual({ label: 'base' });
    expect(checkpoint.pinnedToCurrentState).toBe(true);
  });

  it('accepts the legacy positional call style', async () => {
    global.__responder = () => ok({ id: 'cp-1', state_id: 'state-1', label: 'legacy' });
    const checkpoint = await createCheckpoint('sess-1', 'legacy');
    expect(JSON.parse(calls[0].init.body)).toEqual({ label: 'legacy' });
    expect(checkpoint.label).toBe('legacy');
  });
});
