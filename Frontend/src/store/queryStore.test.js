import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as store from './queryStore';
import { API_ERROR } from '../api/errors';
import traceFixture from '../fixtures/api/trace.recovered.json';
import finishFixture from '../fixtures/api/finish.json';
import applyActionFixture from '../fixtures/api/applyAction.selectColumn.json';

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

function route(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Script the /step decisions for a run. */
function scriptRun(decisions, { finishBody = finishFixture } = {}) {
  let index = 0;
  global.__responder = ({ url, init }) => {
    calls.push({ url, method: init.method });

    if (init.method === 'POST' && /\/queries$/.test(url)) {
      return ok({
        id: 'sess-test',
        request: 'select students',
        root_state_id: 'root-1',
        current_state_id: 'root-1',
        status: 'new',
      });
    }
    if (url.includes('/step')) {
      const decision = decisions[index] ?? { action_type: 'FINISH', parameters: {} };
      index += 1;
      if (decision.__failure) {
        return ok({
          decision: { action_type: decision.action_type, parameters: decision.parameters },
          state: { id: 'state-parent', parent_id: 'root-1', status: 'active', action_count: 1 },
          failure: decision.__failure,
        });
      }
      return ok({
        decision,
        state: {
          id: `state-${index}`,
          parent_id: index === 1 ? 'root-1' : `state-${index - 1}`,
          status: 'active',
          action_count: index,
          action: { action_type: decision.action_type, ...decision.parameters, confidence: 0.9 },
        },
        failure: null,
      });
    }
    if (url.includes('/finish')) return route(finishBody);
    if (url.includes('/trace')) return route(traceFixture);
    if (url.includes('/checkpoints')) return ok({ id: '9b1f5c2e-0000-4000-8000-0000000000c4', state_id: 'state-3', label: 'base' });
    if (url.includes('/branch')) return ok({
      id: 'sess-0000-4000-8000-000000000000',
      request: 'select students\n\nUser clarification: at least 8.5 GPA',
      root_state_id: 'root-1',
      current_state_id: 'bafbad16-0000-4000-8000-000000000003',
      status: 'active',
    });
    if (url.includes('/recover')) return ok({ success: true, state: { id: 'state-branch', parent_id: 'state-3', status: 'active', action_count: 3 }, failure: null });
    return ok({});
  };
}

beforeEach(() => {
  calls.length = 0;
  store.reset();
  global.fetch = vi.fn(async (url, init = {}) => {
    calls.push({ url, init, method: init.method, body: init.body });
    return global.__responder ? global.__responder({ url, init }) : ok({});
  });
});

afterEach(() => {
  delete global.__responder;
  vi.restoreAllMocks();
});

describe('queryStore — the run loop', () => {
  it('runs to FINISH, stores the result, and ends in phase finished', async () => {
    scriptRun([
      { action_type: 'SELECT_TABLE', parameters: { table: 'students' } },
      { action_type: 'FINISH', parameters: {} },
    ]);

    await store.startRun('select students where gpa > 8.5', { stepDelayMs: 0 });

    const state = store.getState();
    expect(state.run.phase).toBe('finished');
    expect(state.run.stepIndex).toBe(2);
    expect(state.result.rowCount).toBe(4);
    expect(state.result.sql).toBe('SELECT * FROM students\nWHERE gpa > 8.5');
    expect(state.result.executionSql).toBe('SELECT * FROM "students"\nWHERE "gpa" > ?');
    expect(state.error).toBeNull();
  });

  it('refreshes the trace after every step, so the UI reads the backend', async () => {
    scriptRun([
      { action_type: 'SELECT_TABLE', parameters: { table: 'students' } },
      { action_type: 'FINISH', parameters: {} },
    ]);

    await store.startRun('select students', { stepDelayMs: 0 });

    const traceCalls = calls.filter((c) => c.url.includes('/trace'));
    expect(traceCalls.length).toBeGreaterThanOrEqual(3); // create + per step + after finish
  });

  it('stops on a structured failure and surfaces the backend message', async () => {
    scriptRun([
      {
        action_type: 'FILTER',
        parameters: { column: 'CGPA', operator: '>', value: 8 },
        __failure: { action_type: 'FILTER', code: 'VALIDATION_FAILED', message: "Column 'CGPA' not found in active tables: ['students']." },
      },
    ]);

    await store.startRun('select students', { stepDelayMs: 0 });

    const state = store.getState();
    expect(state.run.phase).toBe('failed');
    expect(state.error.code).toBe(API_ERROR.BAD_REQUEST);
    expect(state.error.message).toContain('CGPA');
    // the loop must not continue past the failure
    expect(state.run.stepIndex).toBe(1);
  });

  it('stops after maxSteps without finishing', async () => {
    scriptRun(Array.from({ length: 10 }, () => ({ action_type: 'SELECT_COLUMN', parameters: { column: '*' } })));

    await store.startRun('select students', { stepDelayMs: 0, maxSteps: 3 });

    expect(store.getState().run.phase).toBe('failed');
    expect(store.getState().error.message).toContain('3 steps');
  });

  it('treats a graceful agent decline as terminal and lands in phase declined', async () => {
    scriptRun([
      { action_type: 'SELECT_TABLE', parameters: { table: 'students' } },
      {
        action_type: 'ABORT_QUERY',
        parameters: { reason: 'No table matches the requested entities.' },
      },
    ]);

    await store.startRun('select students', { stepDelayMs: 0 });

    const state = store.getState();
    expect(state.run.phase).toBe('declined');
    // isDeclined / isFailed are hook-level selectors derived from run.phase;
    // the raw slice only carries phase, so assert on that.
    expect(state.error.message).toContain('No table matches');
    // the loop must not continue past the decline
    expect(state.run.stepIndex).toBe(2);
  });

  it('surfaces the clarification text for an INSUFFICIENT_INFO decline', async () => {
    scriptRun([
      { action_type: 'SELECT_TABLE', parameters: { table: 'students' } },
      {
        action_type: 'INSUFFICIENT_INFO',
        parameters: { reason: 'Which year?', clarification: 'The graduation year.' },
      },
    ]);

    await store.startRun('select students', { stepDelayMs: 0 });

    expect(store.getState().run.phase).toBe('declined');
    expect(store.getState().error.message).toContain('Which year?');
  });

  it('parks in phase paused in step mode and advances one step at a time', async () => {
    scriptRun([
      { action_type: 'SELECT_TABLE', parameters: { table: 'students' } },
      { action_type: 'SELECT_COLUMN', parameters: { column: '*' } },
      { action_type: 'FINISH', parameters: {} },
    ]);

    await store.startRun('select students', { mode: 'step', stepDelayMs: 0 });
    expect(store.getState().run.phase).toBe('paused');
    expect(store.getState().run.stepIndex).toBe(1);

    await store.stepOnce({ stepDelayMs: 0 });
    expect(store.getState().run.stepIndex).toBe(2);

    await store.stepOnce({ stepDelayMs: 0 });
    expect(store.getState().run.phase).toBe('finished');
  });

  it('aborts an in-flight run and lands in phase aborted', async () => {
    global.fetch = vi.fn(
      (_url, init = {}) =>
        new Promise((_resolve, reject) => {
          // Hangs until the caller's AbortController fires.
          init.signal?.addEventListener?.('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );

    const running = store.startRun('select students', { stepDelayMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.abortRun();
    await running;

    expect(store.getState().run.phase).toBe('aborted');
    expect(store.getState().error).toBeNull(); // cancellation is not an error
  });

  it('refuses to start two runs at once', async () => {
    scriptRun([{ action_type: 'SELECT_TABLE', parameters: { table: 'students' } }]);
    global.fetch = vi.fn(
      (_url, init = {}) =>
        new Promise((_r, reject) => {
          init.signal?.addEventListener?.('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );

    const first = store.startRun('select students', { stepDelayMs: 0 });
    const second = await store.startRun('another query', { stepDelayMs: 0 });
    expect(second).toBeNull();

    store.abortRun();
    await first;
  });

  it('reports an unreachable backend as offline, not as a crash', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await store.startRun('select students', { stepDelayMs: 0 });

    const state = store.getState();
    expect(state.run.phase).toBe('failed');
    expect(state.error.code).toBe(API_ERROR.BACKEND_OFFLINE);
    expect(state.capabilities.online).toBe(false);
  });
});

describe('queryStore — checkpoints and recovery', () => {
  it('refuses to checkpoint with no active session, without a request', async () => {
    const checkpoint = await store.setCheckpoint('state-1', 'base');
    expect(checkpoint).toBeNull();
    expect(store.getState().error.code).toBe(API_ERROR.PREFLIGHT);
    expect(calls.filter((c) => c.url.includes('/checkpoints'))).toHaveLength(0);
  });

  it('recovers using the checkpoint already on the selected node', async () => {
    scriptRun([]);
    await store.openSession('sess-0000-4000-8000-000000000000');
    store.selectNode('bafbad16-0000-4000-8000-000000000003');

    const result = await store.recover({
      action: { action_type: 'FILTER', parameters: { column: 'gpa', operator: '>', value: 8.5 } },
    });

    const recoverCall = calls.find((c) => c.url.includes('/recover'));
    expect(JSON.parse(recoverCall.body)).toEqual({
      checkpoint_id: 'e7590711-0000-4000-8000-0000000000c4',
      correction: { action_type: 'FILTER', parameters: { column: 'gpa', operator: '>', value: 8.5 } },
    });
    expect(result.checkpointId).toBe('e7590711-0000-4000-8000-0000000000c4');
  });

  it('creates a checkpoint when there is nothing to branch from', async () => {
    scriptRun([]);
    await store.openSession('sess-0000-4000-8000-000000000000');
    store.selectNode('389b658f-0000-4000-8000-000000000002'); // no checkpoint on this node

    await store.recover({
      action: { action_type: 'ORDER_BY', parameters: { column: 'gpa', direction: 'DESC' } },
    });

    const urls = calls.map((c) => c.url);
    expect(urls.some((u) => u.includes('/checkpoints'))).toBe(true);
    expect(urls.some((u) => u.includes('/recover'))).toBe(true);
  });

  it('rejects an invalid correction before any request', async () => {
    scriptRun([]);
    await store.openSession('sess-0000-4000-8000-000000000000');

    await expect(
      store.recover({
        checkpointId: 'e7590711-0000-4000-8000-0000000000c4',
        action: { action_type: 'ADD_FILTER', parameters: {} },
      }),
    ).rejects.toMatchObject({ code: API_ERROR.INVALID_ACTION });

    expect(calls.filter((c) => c.url.includes('/recover'))).toHaveLength(0);
  });

  it('branches with clarification and resumes the agent without applying a correction action', async () => {
    scriptRun([{ action_type: 'FINISH', parameters: {} }]);
    await store.openSession('sess-0000-4000-8000-000000000000');
    store.selectNode('bafbad16-0000-4000-8000-000000000003');

    await store.branchWithClarification({
      clarification: 'At least 8.5 GPA',
    });

    const branchCall = calls.find((call) => call.url.includes('/branch'));
    expect(JSON.parse(branchCall.body)).toEqual({
      checkpoint_id: 'e7590711-0000-4000-8000-0000000000c4',
      clarification: 'At least 8.5 GPA',
    });
    expect(calls.some((call) => call.url.includes('/step'))).toBe(true);
    expect(calls.some((call) => call.url.includes('/recover'))).toBe(false);
    expect(store.getState().run.phase).toBe('finished');
  });

  it('reads a cached preview from the trace without a network call', async () => {
    scriptRun([]);
    await store.openSession('sess-0000-4000-8000-000000000000');
    const before = calls.length;

    const preview = store.previewState('a1d6a4af-0000-4000-8000-000000000005');
    expect(preview.rowCount).toBe(4);
    expect(calls.length).toBe(before);
  });
});

describe('queryStore — manual commands', () => {
  it('applies a manual LIMIT to the current session and refreshes the trace', async () => {
    scriptRun([]);
    await store.openSession('sess-0000-4000-8000-000000000000');

    global.__responder = ({ url }) => {
      if (url.includes('/actions')) return route(applyActionFixture);
      if (url.includes('/trace')) return route(traceFixture);
      return ok({});
    };

    const result = await store.applyRawAction({
      action_type: 'LIMIT',
      parameters: { limit: 12 },
    });

    const actionCall = calls.find((call) => call.url.includes('/actions'));
    expect(JSON.parse(actionCall.body)).toEqual({
      action_type: 'LIMIT',
      parameters: { limit: 12 },
    });
    expect(result.success).toBe(true);
    expect(store.getState().run.phase).toBe('idle');
    expect(store.getState().result).toBeNull();
  });

  it('refuses to finish when there is no active session', async () => {
    const result = await store.finishNow();

    expect(result).toBeNull();
    expect(store.getState().error.code).toBe(API_ERROR.PREFLIGHT);
    expect(calls.some((call) => call.url.includes('/finish'))).toBe(false);
  });
});

describe('queryStore — session history', () => {
  it('degrades to unsupported when the list endpoint is missing', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ detail: 'Not Found' }),
      text: async () => '{"detail":"Not Found"}',
    }));

    await store.loadSessions();
    const state = store.getState();
    expect(state.sessions.unsupported).toBe(true);
    expect(state.sessions.items).toEqual([]);
    expect(state.capabilities.listSessions).toBe(false);
    expect(state.error).toBeNull();
  });
});

describe('queryStore — reset', () => {
  it('clears session, trace, selection, result and run', async () => {
    scriptRun([]);
    await store.openSession('sess-0000-4000-8000-000000000000');
    expect(store.getState().trace.graph.nodes.length).toBeGreaterThan(0);

    store.reset();
    const state = store.getState();
    expect(state.session.id).toBeNull();
    expect(state.trace.graph.nodes).toEqual([]);
    expect(state.selection.id).toBeNull();
    expect(state.result).toBeNull();
    expect(state.run.phase).toBe('idle');
  });
});
