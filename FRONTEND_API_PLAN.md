# Frontend API / Methods Layer — Implementation Plan

**Scope:** the frontend **data layer only** — transport, endpoint methods, payload builders, normalizers, store, hooks.
**Out of scope:** any UI/UX. No components, no layout, no styling, no interaction design. A frontend agent builds screens on top of the contract in §9.

Companion docs: `REPO_KNOWLEDGE.md` (repo reference), `FRONTEND_GAMEPLAN.md` (UI plan).

---

## 1. Why a rewrite of `api/client.js` + `useQueryExecution.js`

`client.js` is 11 hand-rolled `fetch` calls. Every one of them:
- throws `new Error(string)` → **status code and FastAPI `detail` are lost** → UI can only show one generic banner
- has no timeout, no abort, no dedupe → a Run click during a running loop races
- accepts `parameters` as anything → the current `handleRecover(node.checkpoint_id || node.id, 'ADD_FILTER', 'GPA > 8.5')` produces **422** (string params) + **400** (bad action type) + **404** (fake checkpoint id)
- has no capability detection → missing endpoints surface as "backend offline"

`useQueryExecution.js` then **invents** data (`confidence: 0.9 + Math.random()*0.08`, `row_count: 50`, `branch_id: 'recovered-branch'`, `is_active_branch`), builds nodes from `applyResult.state.id` (which on failure **equals the parent id** → duplicate React Flow ids), and keeps a second parallel node list (`currentNodesList`) alongside `rawNodes` state.

Target: **one transport, one vocabulary, one source of truth (the trace), zero fabricated fields.**

---

## 2. Target architecture

```
src/
  api/
    config.js        API_BASE, timeouts, previewLimit, env overrides
    errors.js        ApiError + error taxonomy + fromResponse()
    transport.js     request(): fetch + AbortSignal.timeout + retry + envelope
    endpoints.js     path/verb table (single source of truth)
    client.js        thin methods per endpoint  (REPLACES current)
    index.js         single import surface for the UI layer
  lib/
    actions.js       ACTION_TYPES, param specs, buildActionPayload, preflightValidate
    normalize.js     normalizeSession/State/Trace/Result (defensive defaults)
    traceGraph.js    trace -> { nodes, edges, byId, activePath, stats }
    layout.js        tidy-tree layout (pure, no React)
    format.js        params/SQL/values/relative-time
    schema.js        schema cache + column lookup (preflight source)
  store/
    queryStore.js    framework-free store (useSyncExternalStore)
  hooks/
    useApi.js        generic request hook (data/error/loading/refresh, abort on unmount)
    useSession.js    one session: trace, graph, selection, checkpoints
    useQueryRun.js   execution loop: start/pause/step/abort
    useSessionHistory.js
    useAgent.js
  fixtures/
    api/*.json       real captured responses (from probe) for offline dev + tests
  constants/
    backend.js       action vocabulary, operators, join types, directions, limits
```

Rules for every file in this layer:
- **Pure functions where possible** (no React import in `lib/`, `api/`, `constants/`) → unit-testable, reusable by any UI.
- **Never invent a field.** If the backend doesn't return it, return `null`/`undefined` and expose `capabilities` flags.
- **Never mutate.** Return new objects (React Compiler is enabled).
- **Never swallow errors.** Every method rejects with `ApiError`.

---

## 3. L0 — `constants/backend.js`

Single source of truth for the vocabulary (kills the `mock.js` fake names).

```js
export const ACTION_TYPES = { SELECT_TABLE:'SELECT_TABLE', SELECT_COLUMN:'SELECT_COLUMN',
  FILTER:'FILTER', JOIN:'JOIN', GROUP_BY:'GROUP_BY', ORDER_BY:'ORDER_BY', LIMIT:'LIMIT', FINISH:'FINISH' };

export const OPERATORS   = ['=','!=','>','>=','<','<=','LIKE','IN','IS NULL','IS NOT NULL'];
export const JOIN_TYPES  = ['INNER','LEFT','RIGHT'];
export const DIRECTIONS  = ['ASC','DESC'];

/** Which actions are legal to submit as a recovery correction. */
export const CORRECTABLE_ACTIONS = [FILTER, SELECT_COLUMN, JOIN, GROUP_BY, ORDER_BY, LIMIT];

/**
 * Param spec per action — drives payload building AND preflight validation.
 * kind: 'string'|'column'|'table'|'operator'|'number'|'boolean'|'json'
 * required: boolean
 */
export const ACTION_SPECS = {
  SELECT_TABLE:  { table:{kind:'table',required:true} },
  SELECT_COLUMN: { column:{kind:'column',required:true}, table:{kind:'table'}, alias:{kind:'string'} },
  FILTER:        { column:{kind:'column',required:true}, operator:{kind:'operator',required:true},
                   value:{kind:'string', requiredWhen: op => !/IS (NOT )?NULL/.test(op)},
                   table:{kind:'table'} },
  JOIN:          { table:{kind:'table',required:true}, left_on:{kind:'column',required:true},
                   right_on:{kind:'column',required:true}, join_type:{kind:'string', default:'INNER'} },
  GROUP_BY:      { column:{kind:'column',required:true}, table:{kind:'table'} },
  ORDER_BY:      { column:{kind:'column',required:true}, direction:{kind:'string', default:'ASC'}, table:{kind:'table'} },
  LIMIT:         { limit:{kind:'number',required:true,min:1} },
  FINISH:        {},
};

export const STATUS = { NEW:'new', ACTIVE:'active', FAILED:'failed', COMPLETED:'completed' };
export const FAILURE_CODES = { VALIDATION:'VALIDATION_FAILED', STATE:'STATE_TRANSITION_FAILED',
  SQL:'SQL_COMPILATION_FAILED', DB:'DATABASE_EXECUTION_FAILED' };
```

---

## 4. L1 — Transport & errors

### `api/errors.js`

```js
export const API_ERROR = {
  NETWORK:'NETWORK', TIMEOUT:'TIMEOUT', ABORTED:'ABORTED',
  NOT_FOUND:'NOT_FOUND', BAD_REQUEST:'BAD_REQUEST', UNPROCESSABLE:'UNPROCESSABLE',
  SERVER:'SERVER', BACKEND_OFFLINE:'BACKEND_OFFLINE', UNSUPPORTED:'UNSUPPORTED',
  NO_CHECKPOINT:'NO_CHECKPOINT', INVALID_ACTION:'INVALID_ACTION', PREFLIGHT:'PREFLIGHT',
};

export class ApiError extends Error {
  constructor(message, { code, status, detail, endpoint, method, body } = {}) {
    super(message); this.name='ApiError';
    Object.assign(this, { code, status, detail, endpoint, method, body });
  }
  get isNetwork()  { return this.code === API_ERROR.NETWORK || this.code === API_ERROR.BACKEND_OFFLINE; }
  get isRecoverable(){ return this.code === API_ERROR.BAD_REQUEST || this.code === API_ERROR.UNPROCESSABLE
                           || this.code === API_ERROR.PREFLIGHT || this.code === API_ERROR.NO_CHECKPOINT; }
  get isMissingEndpoint(){ return this.code === API_ERROR.NOT_FOUND && this.endpoint?.includes('/queries') && !this.endpoint.includes('/actions'); }
}

export function mapStatus(status, endpoint) { /* 0→NETWORK, 401/403→…, 404→NOT_FOUND, 400→BAD_REQUEST, 422→UNPROCESSABLE, >=500→SERVER */ }
export async function fromResponse(res, { endpoint, method }) { /* parse FastAPI {detail} incl. 422 array-of-{loc,msg} → readable string */ }
```

> 422 `detail` from FastAPI is an **array of `{loc, msg, type}`** — the current client does `err.detail || '…'` and renders `[object Object]`. Normalize it into `detail: string` + `fields: string[]` so forms can highlight the offending field.

### `api/transport.js`

```js
export async function request(path, { method='GET', body, signal, timeout=15000, retries=0, idempotent } = {})
// → parsed JSON
// - builds URL from API_BASE, JSON-encodes body when present
// - composes AbortSignal.any([userSignal, AbortSignal.timeout(timeout)])
// - retries idempotent GETs (default 2, backoff 300/900ms)
// - on !res.ok → throw await fromResponse(res, {endpoint, method})
// - on TypeError/network → ApiError(BACKEND_OFFLINE, message: 'Backend unreachable at <API_BASE>')
// - on AbortError → ApiError(ABORTED)
// - logs a one-line console.debug with a request id
```

### `api/endpoints.js`

```js
export const EP = {
  createSession:   { m:'POST',   p:'/queries' },
  getSession:      s => ({ m:'GET',  p:`/queries/${s}` }),
  nextAction:      s => ({ m:'POST', p:`/queries/${s}/next-action` }),
  applyAction:     s => ({ m:'POST', p:`/queries/${s}/actions` }),
  step:            s => ({ m:'POST', p:`/queries/${s}/step` }),        // Phase-0 backend, optional
  checkpoint:      s => ({ m:'POST', p:`/queries/${s}/checkpoints` }),
  recover:         s => ({ m:'POST', p:`/queries/${s}/recover` }),
  finish:          s => ({ m:'POST', p:`/queries/${s}/finish` }),
  trace:           s => ({ m:'GET',  p:`/queries/${s}/trace` }),
  listSessions:    { m:'GET',    p:'/queries' },
  agentStatus:     { m:'GET',    p:'/queries/agent/status' },
  agentSelect:     { m:'POST',   p:'/queries/agent/select' },
  health:          { m:'GET',    p:'/health' },
};
```

---

## 5. L2 — `api/client.js` (method table)

Every method: `(args, opts?) → Promise<normalized DTO>`, `opts` = `{ signal, timeout }`.

| Method | Signature | Returns | Notes |
|---|---|---|---|
| `health()` | `()` | `{ok:boolean, version?}` | 2s timeout, used by capability probe |
| `createSession(request)` | `(string)` | `SessionDTO` | trims + rejects empty client-side |
| `getSession(id)` | `(string)` | `StateDTO` | current state |
| `getNextAction(id)` | `(string)` | `{action_type, parameters}` | **decide-only**, does not persist |
| `applyAction(id, action, opts)` | `(string, ActionInput, {preflight})` | `ActionResponseDTO` | `ActionInput` = `{action_type, parameters}` **or** `{type, params}`; normalized by `buildActionPayload` |
| `step(id, opts)` | `(string)` | `{decision, state, failure}` | feature-detected; falls back to `nextAction`+`applyAction` |
| `createCheckpoint(id, {stateId, label})` | | `CheckpointDTO` | sends `state_id` when provided (backend Phase 0.2); omits it otherwise |
| `recover(id, {checkpointId, action, label})` | | `ActionResponseDTO` | validates checkpoint id is a **real** id → else `ApiError(NO_CHECKPOINT)` before the network |
| `finish(id)` | `()` | `QueryResultDTO` | |
| `getTrace(id)` | `(string)` | `TraceDTO` (normalized) | |
| `listSessions({status, q, limit})` | | `{items, unsupported}` | 404/405 → `{items:[], unsupported:true}` (never throws) |
| `getAgentStatus()` | `()` | `{active_agent, registered, model_name, base_url}` | |
| `selectAgent(type)` | `(string)` | `{active_agent}` | |

`ActionResponseDTO` = `{ success, state: StateDTO, failure: {action_type, code, message, state_id?} | null, raw }`

**Deprecation shims** (so `App.jsx` compiles untouched during migration):
```js
/** @deprecated use applyAction(id, {action_type, parameters}) */
export async function recoverFromCheckpoint(sessionId, checkpointId, correction) { … }
/** @deprecated use createCheckpoint(id, {label}) */
export async function createCheckpoint(sessionId, label) { … }
```
Shims keep old call sites alive but `console.warn` and route through the new builders.

---

## 6. L3 — Payload builders & preflight (`lib/actions.js`, `lib/schema.js`)

This is the layer that makes the killer demo **impossible to break**.

```js
export function normalizeActionInput(input)      // {type|action|action_type, params|parameters} -> {action_type, parameters}
export function buildActionPayload(actionType, params)
// → { action_type, parameters }
// 1. reject unknown actionType  -> ApiError(INVALID_ACTION, `Unsupported action_type: X. Allowed: …`)
// 2. coerce per ACTION_SPECS: number for limit, string for column/table, drop unknown keys
// 3. enforce required -> ApiError(PREFLIGHT, "FILTER requires column, operator, value")
// 4. enforce `parameters` is ALWAYS a plain object (kills the 422)
// 5. operator normalization: uppercase, `IS NULL`/`IS NOT NULL` drop `value`
export function preflightValidate(actionType, params, { schema, state })
// mirrors DeterministicValidator rules client-side:
//  - table exists in schema (if schema known)
//  - column exists in active tables (state.activeTables) — `*` always ok
//  - base table exists for non-SELECT_TABLE actions
//  - limit positive int, direction in ASC|DESC, join_type in INNER|LEFT|RIGHT
//  - JOIN: target not already active; right_on exists in target table
// → { ok: true } | { ok:false, errors:[{field, message}] }
export function describeAction(actionType, params)   // "FILTER gpa > 8.5"  (edge labels, logs)
export function actionSignature(actionType)          // [{name, kind, required, default}] for form rendering
```

`lib/schema.js` — schema cache so preflight works without a backend endpoint:
```js
export function setSchema(DatabaseSchemaDTO)         // from GET /queries/{id}/schema when it exists
export function schemaFromTrace(trace)               // fallback: derive table/column names from previews + actions
export function activeTables(stateActions)           // SELECT_TABLE + JOIN tables
export function columnsFor(tables, schema)           // [] when unknown -> preflight degrades to "can't verify"
export function knownColumns(state, schema)          // union of schema columns + preview columns
```
> Preflight is **advisory**: on unknown schema it returns `{ok:true, unverified:true}`. It never blocks a request the backend would accept.

---

## 7. L4 — Normalizers (`lib/normalize.js`, `lib/traceGraph.js`)

### `normalize.js`
Defensive: every DTO gets defaults so a partial backend response can't crash consumers.
```js
normalizeSession, normalizeState, normalizePreview, normalizeFailure,
normalizeCheckpoint, normalizeAction, normalizeResult, normalizeTrace
```
`normalizeState` output (the shape the UI codes against):
```js
{
  id, parentId, status,               // 'new'|'active'|'failed'|'completed'
  actionCount, sql,
  action: { type, params, confidence } | null,
  preview: { columns, rows, rowCount, truncated, executionTimeMs } | null,
  decision: { probabilities, latencyMs, modelVersion } | null,   // null until backend Phase 0.4
  failure: { code, message, actionType } | null,
  checkpoint: { id, label } | null,
  isCurrent: false,
  raw,                                // untouched server payload
}
```
> camelCase in the DTOs, with `raw` preserved. Provide `snake` aliases on the node object during the transition so existing `App.jsx` bindings keep working (`row_count`, `parent_id`, `checkpoint_id`, `execution_time_ms`).

### `traceGraph.js` — the **only** trace → graph mapping
```js
export function normalizeTrace(trace) → {
  session, current,
  nodes: [{ id, parentId, status, action, params, confidence, preview, sql,
            checkpoint, failure, isCurrent, depth, branchId, lane,
            position:{x,y}, isTerminal }],
  edges: [{ id, source, target, kind:'success'|'failed'|'recovered'|'inactive',
            animated, label, markerEnd }],
  byId: Map, childrenOf: Map,
  checkpoints: [{id, stateId, label, stateAction}],
  failures:  [{stateId, actionType, code, message}],
  activePath: [stateId…],            // ancestors of session.current_state_id
  stats: { stateCount, actionCount, checkpointCount, failureCount,
           totalLatencyMs, rowCount, modelVersion, finishedAt },
}
export function deriveActivePath(trace)      // walk parent chain from current_state_id
export function deriveBranches(trace)        // fork points → branchId per subtree
export function isOnActivePath(stateId)
export function edgeKind(child, parent, {activePath, failures})
export function graphStats(trace)
```
Rules:
- Node id **is** `state.id`; if a trace state id repeats, append `#2` and log — never silently collide.
- `kind = 'failed'` when the state has a failure; `'recovered'` when its parent is a checkpoint **and** it is on the active path; `'inactive'` when off the active path; else `'success'`.
- `label = describeAction(...)` for recovered edges.
- `markerEnd: { type:'arrowclosed', color }` on every edge.
- **No invented confidence/row counts.** Missing → `null`.

### `layout.js`
```js
export function tidyTreeLayout(nodes, { levelGap=180, siblingGap=300, laneGap=120 })
// leaf x = running counter; parent x = mean(children.x); branch subtrees get lane offsets
export function recomputePositions(nodes, { focusId })   // centers focus
```
Pure, deterministic, no React.

### `format.js`
`formatParam(name, value)`, `formatActionLabel(type, params)`, `formatSql(sql)`, `formatMs(ms)`,
`formatConfidence(c)` → `0–100 | null`, `formatRows(n)`, `relativeTime(iso)`, `cellValue(v)` (null → `∅`, numbers right-aligned flag).

---

## 8. L5/L6 — Store & hooks

### `store/queryStore.js`
Framework-free, `useSyncExternalStore`, immutable. Removes prop drilling and the `currentNodesList`/`rawNodes` split-brain.
```js
state shape:
{
  capabilities: { health, listSessions, step, checkpointStateId, agentStatus },
  backend:  { online, agent, model, baseUrl, checkedAt },
  sessions: { list, listStatus:'idle|loading|error|unsupported', filter:{status,q} },
  session:  { id, request, status, current, loading },
  trace:    { data, nodes, edges, byId, stats, status:'idle|loading|ready|error', fetchedAt },
  run:      { phase:'idle|deciding|applying|finished|failed|aborted', step, lastAction, nextAction, startedAt },
  selection:{ id, node },
  result:   { sql, columns, rows, rowCount, executionTimeMs } | null,
  error:    { code, message, detail, fields, endpoint } | null,
  busy:     { [endpointKey]: true },
}
export const queryStore = { get, set, patch, subscribe, select(selector) }
export function useQueryStore(selector)   // useSyncExternalStore wrapper
```

### Hooks — the public contract for the UI agent

**`useAgent()`**
```js
{ agent, model, baseUrl, online, registered, switching, refresh(), selectAgent(type) }
```

**`useSessionHistory({status, q})`**
```js
{ sessions, loading, error, unsupported, refresh, setFilter({status,q}), openSession(id) }
```

**`useSession(sessionId?)`** — one session, trace-driven
```js
{
  session, trace, nodes, edges, stats,
  byId, checkpoints, failures, activePath,
  selected: { id, node },
  selectNode(id),
  refresh(),                       // refetch trace
  status: 'idle'|'loading'|'ready'|'error',
}
```

**`useQueryRun()`** — the execution loop, cancellable
```js
{
  start(prompt, { mode:'auto'|'step', maxSteps=25, stepDelayMs=380, signal }),
  pause(), resume(), stepOnce(), abort(), reset(),
  phase, stepIndex, lastDecision, nextActionPreview,
  isRunning, canPause, canStep,
  result,                          // finish() payload
  error,
}
```
Loop contract:
1. `createSession` → 2. loop `{ step | nextAction+applyAction }` → 3. stop on `FINISH` / failure / `maxSteps` / abort → 4. `finish()` → 5. **`refresh()` trace after every mutation** (UI reads the trace, never the loop's local list).
- `AbortController` per run; `abort()` cancels in-flight fetch and marks `phase:'aborted'`.
- `stepDelayMs = 0` for tests, `380` for the animated demo.
- `onStep` callback param for future animation/telemetry; hooks must not know about React.
- Failure handling: **do not build a node locally.** Persist nothing; refetch trace and let `normalizeTrace` paint it. (If backend Phase 0.3 lands, the failed state arrives as a real node.)

**`useApi(fn, deps)`** — generic request hook for ad-hoc calls
```js
{ data, loading, error, run, refresh, abort }   // aborts on unmount
```

**Convenience methods exposed by `useSession` (the checkpoint/recovery handlers):**
```js
setCheckpoint(stateId, label)      → CheckpointDTO   // throws ApiError(NO_CHECKPOINT) if no session
forceFailure(stateId?)             → ActionResponseDTO  // applies FILTER CGPA > 8 → deterministic demo failure
recover({ checkpointId?, stateId?, action })
  // resolution order: explicit checkpointId → checkpoint on stateId → create checkpoint on stateId → throw NO_CHECKPOINT
  // payload: { checkpoint_id, correction: buildActionPayload(...) }  // always a dict
  // then refresh() and return { result, trace }
listCheckpoints()                  → CheckpointDTO[]
previewState(stateId)              → StateDTO (from cached trace, no network)
```

---

## 9. Handoff contract (what the UI agent codes against)

The UI agent imports **only** from `src/api/index.js`, `src/hooks/*`, and `src/lib/*`.

```js
// data
import { queryStore, useQueryStore } from '@/store/queryStore'
import { useQueryRun }     from '@/hooks/useQueryRun'
import { useSession }      from '@/hooks/useSession'
import { useSessionHistory } from '@/hooks/useSessionHistory'
import { useAgent }        from '@/hooks/useAgent'

// helpers
import { ACTION_TYPES, ACTION_SPECS, OPERATORS, actionSignature } from '@/constants/backend'
import { buildActionPayload, preflightValidate, describeAction }   from '@/lib/actions'
import { normalizeTrace }                                          from '@/lib/traceGraph'
import { formatActionLabel, formatConfidence, formatMs }           from '@/lib/format'
```

Guarantees the UI can rely on:
- `nodes` / `edges` are **ready to hand to React Flow** (positions included, ids unique, `markerEnd` set).
- `node.preview` is `{columns, rows, rowCount, truncated, executionTimeMs} | null` — never a fabricated number.
- `node.confidence` is `number | null`; `node.decision` is `null` until the backend emits it → UI renders "not reported" instead of a fake bar.
- `error.code` ∈ `API_ERROR` → UI maps code → component (toast / inline field / banner).
- `capabilities.listSessions === false` → sidebar renders "history unavailable", not a crash.
- Every async method rejects with `ApiError` carrying `{code, status, detail, fields, endpoint}`.

---

## 10. Graceful degradation (so this layer is not blocked on backend work)

`probeCapabilities()` runs on mount (and on `health` failure):
```js
{ health: true, listSessions: false, step: false, checkpointStateId: false, agentStatus: true }
```
Detection = cheap probes + memoized result + `ApiError(UNSUPPORTED)` on 404/405.

| Missing backend feature | Frontend behaviour |
|---|---|
| `GET /queries` | `listSessions()` → `{items:[], unsupported:true}`; history hook exposes `unsupported` |
| `checkpoint(state_id)` | send `state_id` optimistically; on 422 unknown-field, retry without it and set `capabilities.checkpointStateId=false`, surface `warning: 'checkpoint pinned to current state'` |
| `POST /step` | fall back to `nextAction` + `applyAction` (2 calls) |
| `failures[].state_id` | failures attach to the **parent** state with `failure.ambiguous = true` |
| `decision.probabilities` | `node.decision = null` |
| LM Studio down | `ApiError(BACKEND_OFFLINE)` from `next-action` with `detail` containing the connection error → `run.phase='failed'`, `error.code='BACKEND_OFFLINE'` |

---

## 11. Fixtures & tests

`src/fixtures/api/` — captured from the live probe (already known-good shapes):
```
createSession.json  applyAction.selectTable.json  applyAction.selectColumn.json
applyAction.failure.json   checkpoint.json   recover.json   trace.recovered.json
finish.json   listSessions.json (target shape)   agentStatus.json
```
`src/fixtures/expected/trace.recovered.graph.json` — snapshot of `normalizeTrace` output.

Tests (pure functions only, no DOM):
- `lib/actions.test.js` — payload building: unknown type → `INVALID_ACTION`; missing required → `PREFLIGHT`; `parameters` always object; `IS NULL` drops value; `limit` coerced to number; unknown keys dropped.
- `lib/traceGraph.test.js` — 5-state recovered fixture → 5 nodes, 4 edges, unique ids, `activePath` correct, failed state kind, checkpoint linkage.
- `lib/layout.test.js` — no two nodes share a position; siblings of different parents don't overlap; deterministic output.
- `api/errors.test.js` — 422 array detail → readable `detail` + `fields`.
- `hooks/useQueryRun.test.js` — fake client injection: auto loop stops at FINISH; failure stops loop; abort cancels.

Add dev deps: `vitest` (+ `npm run test`, `npm run test:watch`). No DOM/RTL required for the layer; keep it pure so it stays fast.

---

## 12. Build order & estimates

| # | Task | Files | Est | Depends |
|---|---|---|---|---|
| 1 | Constants + payload builders + preflight | `constants/backend.js`, `lib/actions.js`, `lib/schema.js` | 0.5 d | — |
| 2 | Errors + transport + endpoints | `api/errors.js`, `api/transport.js`, `api/endpoints.js`, `api/config.js` | 0.5 d | — |
| 3 | New `client.js` + `index.js` + deprecation shims | `api/client.js`, `api/index.js` | 0.5 d | 1,2 |
| 4 | Normalizers + trace graph + layout + format | `lib/normalize.js`, `lib/traceGraph.js`, `lib/layout.js`, `lib/format.js` | 1.0 d | 3 |
| 5 | Store + `useApi` + `useAgent` + `useSessionHistory` + capability probe | `store/queryStore.js`, `hooks/*` | 0.75 d | 3,4 |
| 6 | `useSession` (selection, checkpoints, recover, forceFailure) | `hooks/useSession.js` | 0.5 d | 5 |
| 7 | `useQueryRun` (loop, abort, step mode, trace refetch) | `hooks/useQueryRun.js` | 0.75 d | 5,6 |
| 8 | Fixtures + vitest + `npm run test` | `fixtures/**`, `*.test.js`, `package.json` | 0.5 d | 1–7 |
| 9 | Delete `mock.js` fabricated fields from the layer; wire `App.jsx` to new hook (mechanical, ~40 lines) | `App.jsx` | 0.25 d | 7 |

**≈ 4.75 days.** Critical path 1/2 → 3 → 4 → 5 → 7.
Tasks 1, 2, 3 are independent and can be done in parallel by two people.

---

## 13. Asks for the backend (ordered by how much they unblock this layer)

| Ask | Frontend fallback if absent |
|---|---|
| `failures[].state_id` | attach to parent + `failure.ambiguous` |
| `GET /queries` (list) | `unsupported` flag |
| `checkpoint(state_id)` | pin current + warning |
| `POST /step` | 2-call fallback |
| `agent_decisions` → `state.decision {probabilities, confidence, latency_ms}` | `decision: null` |
| `GET /queries/{id}/schema` (tables+columns) | derive from previews (preflight degrades) |
| `finish()` keeps preview | use `result.rows` for the final node |
| `recovery_logs` / checkpoint→branch lineage | infer from `parent_id == checkpoint.state_id` |
| CORS: explicit origins with credentials | n/a |

None of these block tasks 1–8; they only change `capabilities` flags and how much of the inspector is real vs. "not reported".

---

## 14. Definition of done

- [ ] No `fetch` outside `api/transport.js`.
- [ ] No `new Error(` in the frontend layer — only `ApiError` with a `code` from `API_ERROR`.
- [ ] Zero hardcoded/mock data in `api/`, `lib/`, `hooks/`; `mock.js` is not imported by any of them.
- [ ] `grep -rn "Math.random" src/api src/lib src/hooks` → empty.
- [ ] `grep -rn "ADD_TABLE\|ADD_JOIN\|ADD_FILTER\|HAVING\|EXECUTE" src/api src/lib src/hooks` → empty.
- [ ] Every mutation method is followed by a trace refetch inside the hook (not in components).
- [ ] `normalizeTrace` on the 5-state recovered fixture yields 5 unique node ids (no parent-id reuse).
- [ ] `recover()` cannot send a non-dict `parameters` and cannot send a non-whitelisted `action_type` (pre-network).
- [ ] `abort()` cancels an in-flight run within one request.
- [ ] `npm run test` green; `npm run build` green; `npm run lint` clean.
- [ ] `App.jsx` compiles unchanged against the new hook's return shape (shims provided).
