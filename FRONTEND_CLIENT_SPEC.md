# Frontend Client & Backend Connector Spec Sheet

> **Audience:** Frontend UI Developers and AI Agents building UI components, dialogs, drawers, and panels.  
> **Scope:** The complete frontend data and connector layer (`api/*`, `hooks/*`, `store/*`, `lib/*`, `constants/*`).  
> **Golden Rule:** **UI components must never call `fetch` directly.** All data access and mutations flow through the custom hooks and store.

---

## 1. Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                        FRONTEND UI LAYER                              │
│   (App.jsx, NodeInspector, RecomputeDialog, FlowCanvas, Sidebar, etc.)│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (consume state & triggers)
┌───────────────────────────────────▼────────────────────────────────────┐
│                         CUSTOM REACT HOOKS                             │
│   • useSession()         • useQueryRun()                               │
│   • useSessionHistory()  • useAgent()                                  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (delegates to)
┌───────────────────────────────────▼────────────────────────────────────┐
│                    GLOBAL QUERY STORE (queryStore.js)                  │
│       • useSyncExternalStore subscription (React Compiler safe)         │
│       • Trace graph synchronization (lib/traceGraph.js)                │
│       • Client-side layout engine (lib/layout.js)                       │
│       • Schema cache & validator (lib/schema.js)                       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (calls normalized methods)
┌───────────────────────────────────▼────────────────────────────────────┐
│                      API CLIENT (api/client.js)                        │
│       • Normalized DTO mappers (lib/normalize.js)                      │
│       • Typed payloads & action validators (lib/actions.js)            │
│       • Endpoint table (api/endpoints.js)                              │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (manages HTTP)
┌───────────────────────────────────▼────────────────────────────────────┐
│                    HTTP TRANSPORT (api/transport.js)                   │
│       • Timeout & AbortController handling                             │
│       • Status code mapping & ApiError normalization                   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP JSON
┌───────────────────────────────────▼────────────────────────────────────┐
│                    FASTAPI BACKEND (:8000)                             │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Hooks Reference

All hooks are imported from `@/hooks` or `./hooks/*`.

### 2.1 `useSession({ autoLoad = true })`
Manages the current active session, graph nodes/edges, selection, and checkpoint/recovery actions.

```javascript
import { useSession } from './hooks/useSession';

const session = useSession();
```

#### State Properties
| Property | Type | Description |
| :--- | :--- | :--- |
| `session.session` | `object` | `{ id: string, request: string, status: string, current: string }` |
| `session.nodes` | `Array<Node>` | React Flow nodes array generated from the backend trace graph |
| `session.edges` | `Array<Edge>` | React Flow edges with colored status markers (`success`, `failed`, `recovered`) |
| `session.selectedNodeId` | `string \| null`| ID of the currently selected graph node |
| `session.selectedNode` | `object \| null`| Full normalized data of the selected node (details below) |
| `session.checkpoints` | `Array<object>` | Checkpoints list: `[{ id, stateId, label }]` |
| `session.checkpointsForState`| `Map<string, Checkpoint>` | Map from `stateId` to pinned `Checkpoint` |
| `session.stats` | `object` | Graph summary: `{ actionCount, rowCount, totalLatencyMs }` |
| `session.isOnline` | `boolean` | `true` if FastAPI backend is healthy |
| `session.isBusy` | `boolean` | `true` if an async action (checkpoint, recover, etc.) is in-flight |
| `session.error` | `object \| null`| Last error: `{ message, code, detail, fields }` |

#### Action Methods
* **`session.selectNode(nodeId)`**: Sets the selected node by ID.
* **`session.setCheckpoint(stateId, label)`**: Pins a checkpoint to any historical node.
  ```javascript
  await session.setCheckpoint(selectedNode.id, "base_filtered");
  ```
* **`session.recover({ checkpointId, action })`**: Branches from a checkpoint with a correction action.
  ```javascript
  await session.recover({
    checkpointId: "e7590711-...",
    action: { action_type: "FILTER", parameters: { column: "gpa", operator: ">", value: 8.5 } }
  });
  ```
* **`session.applyAction(action)`**: Manually applies an explicit action to the current state.
* **`session.previewState(stateId)`**: Returns the cached intermediate preview for any state without network traffic:
  ```javascript
  const preview = session.previewState(node.id);
  // { columns: string[], rows: object[], rowCount: number, truncated: boolean, executionTimeMs: number }
  ```
* **`session.openSession(sessionId)`**: Loads a historical session and its trace graph into view.
* **`session.clearError()`**: Clears the error banner.
* **`session.reset()`**: Resets graph, session, and selection to initial state.

---

### 2.2 `useQueryRun({ mode = 'auto' })`
Controls query stepping, auto-execution, pausing, aborting, and finishing.

```javascript
import { useQueryRun } from './hooks/useQueryRun';

const run = useQueryRun();
```

#### State Properties
| Property | Type | Description |
| :--- | :--- | :--- |
| `run.isRunning` | `boolean` | Query execution loop is actively advancing |
| `run.isPaused` | `boolean` | Run loop paused in step mode |
| `run.isFinished`| `boolean` | Query completed via `FINISH` action |
| `run.isFailed` | `boolean` | Run stopped due to an error or validation failure |
| `run.isAborted` | `boolean` | User cancelled execution via `run.abort()` |
| `run.stepIndex` | `number` | Counter of executed steps (1, 2, 3...) |
| `run.lastAction`| `object` | Last decided/applied action `{ action_type, parameters }` |
| `run.result` | `object \| null`| Final execution result (SQL, rows, rowCount, executionTimeMs) |

#### Action Methods
* **`run.start(promptText, { mode: 'auto' | 'step' })`**: Starts session and execution loop.
* **`run.stepOnce()`**: Advances one step when paused in step mode.
* **`run.pause()`**: Pauses an auto-run loop.
* **`run.resume()`**: Resumes a paused run in auto mode.
* **`run.abort()`**: Immediately aborts network requests and cancels the run.
* **`run.finish()`**: Explicitly executes final query and fetches all rows without preview limits.

---

### 2.3 `useSessionHistory({ autoLoad = true })`
Provides session history for the left sidebar with search and filtering.

```javascript
import { useSessionHistory } from './hooks/useSessionHistory';

const history = useSessionHistory();
```

#### State & Methods
* **`history.sessions`**: Array of visible sessions matching the filter.
  ```json
  [
    {
      "id": "sess-uuid",
      "request": "Students with GPA > 8.5",
      "status": "completed",
      "modelVersion": "rule",
      "createdAt": "2026-10-07T13:04:11Z",
      "updatedAt": "2026-10-07T13:04:19Z",
      "stateCount": 5,
      "hasFailure": true
    }
  ]
  ```
* **`history.loading`**: `boolean` while fetching sessions.
* **`history.unsupported`**: `false` (backend `GET /queries` is fully implemented).
* **`history.filter`**: `{ q: string, status: string | null }`.
* **`history.setFilter({ q, status })`**: Updates filter and refetches:
  ```javascript
  history.setFilter({ status: 'completed' }); // 'completed' | 'failed' | null
  history.setFilter({ q: 'engineering' });
  ```
* **`history.refresh()`**: Triggers a manual refresh of the sessions list.
* **`history.openSession(id)`**: Loads the selected historical session into the canvas.

---

### 2.4 `useAgent({ autoLoad = true })`
Inspects and switches the backend decision-making model adapter.

```javascript
import { useAgent } from './hooks/useAgent';

const agent = useAgent();
```

* `agent.agent`: Active agent identifier (`'rule'` | `'ornith'`).
* `agent.registered`: List of registered agents (e.g. `['rule', 'ornith']`).
* `agent.model`: Model name string (e.g. `'ornith-1.5'`).
* `agent.baseUrl`: Backend inference URL (e.g. `'http://localhost:1234/v1'`).
* `agent.selectAgent('ornith')`: Switches active model asynchronously.

---

## 3. Canonical Action Space & Specifications

When building forms or recovery dialogs, use canonical action types from `constants/backend.js`. **Never invent action names.**

```javascript
import { ACTION_TYPES, OPERATORS, JOIN_TYPES, ORDER_DIRECTIONS } from '@/constants/backend';
```

### Action Types & Parameter Payloads

#### 1. `SELECT_TABLE`
Selects base table. Legal only as the first action.
```json
{
  "action_type": "SELECT_TABLE",
  "parameters": {
    "table": "students"
  }
}
```

#### 2. `SELECT_COLUMN`
Projects a column. `*` is legal.
```json
{
  "action_type": "SELECT_COLUMN",
  "parameters": {
    "column": "gpa",
    "table": "students",       // optional
    "alias": "student_gpa"     // optional
  }
}
```

#### 3. `FILTER`
Adds a WHERE condition.
```json
{
  "action_type": "FILTER",
  "parameters": {
    "column": "gpa",
    "operator": ">",           // '=', '!=', '>', '>=', '<', '<=', 'LIKE', 'IN', 'IS NULL', 'IS NOT NULL'
    "value": 8.5,              // string, number, or array for 'IN'. Omitted for 'IS NULL' / 'IS NOT NULL'
    "table": "students"        // optional
  }
}
```

#### 4. `JOIN`
Adds an INNER/LEFT/RIGHT join.
```json
{
  "action_type": "JOIN",
  "parameters": {
    "table": "courses",
    "left_on": "department_id",
    "right_on": "department_id",
    "join_type": "INNER"       // 'INNER' | 'LEFT' | 'RIGHT'
  }
}
```

#### 5. `GROUP_BY`
```json
{
  "action_type": "GROUP_BY",
  "parameters": {
    "column": "department_id",
    "table": "students"        // optional
  }
}
```

#### 6. `ORDER_BY`
```json
{
  "action_type": "ORDER_BY",
  "parameters": {
    "column": "gpa",
    "direction": "DESC",       // 'ASC' | 'DESC'
    "table": "students"        // optional
  }
}
```

#### 7. `LIMIT`
```json
{
  "action_type": "LIMIT",
  "parameters": {
    "limit": 10                // positive integer
  }
}
```

#### 8. `FINISH`
No parameters.
```json
{
  "action_type": "FINISH",
  "parameters": {}
}
```

---

## 4. Schema Cache & Autocomplete Helpers

Imported from `@/lib/schema`:
```javascript
import { 
  getSchema, 
  loadSchema, 
  hasSchema, 
  tableNames, 
  columnsFor, 
  hasTable, 
  hasColumn 
} from '@/lib/schema';
```

* **`loadSchema()`**: Automatically called on app startup via `probe()`. Can be called manually to refresh schema metadata.
* **`tableNames()`**: Returns list of all table names: `['students', 'courses', 'departments']`.
* **`columnsFor([tables])`**: Returns array of available column names for specified tables.
  ```javascript
  const cols = columnsFor(['students']); // ['id', 'name', 'gpa', 'department_id']
  ```
* **`hasTable(name)`**: Checks if table exists in backend database (`true` | `false`).
* **`hasColumn(column, [tables])`**: Validates column name against active tables.

---

## 5. UI Integration Recipes

### Recipe A: Step 3 — Node Inspector Drawer
Inspects whatever node the user clicked in React Flow.

```jsx
import { useSession } from '@/hooks/useSession';
import { formatMs, formatConfidence, confidenceTone } from '@/lib/format';

export function NodeInspector() {
  const { selectedNode, setCheckpoint, recover, previewState } = useSession();

  if (!selectedNode) {
    return <div>Select a node to inspect its details</div>;
  }

  const preview = previewState(selectedNode.id);

  return (
    <div className="inspector">
      <h3>{selectedNode.action || 'Root State'}</h3>
      <p>Status: {selectedNode.status}</p>

      {/* Confidence */}
      {selectedNode.confidence != null && (
        <div className={`confidence-${confidenceTone(selectedNode.confidence)}`}>
          Confidence: {formatConfidence(selectedNode.confidence)}
        </div>
      )}

      {/* Structured Parameters */}
      <div className="parameters">
        <h4>Parameters</h4>
        <pre>{JSON.stringify(selectedNode.params, null, 2)}</pre>
      </div>

      {/* Bounded Preview Table */}
      {preview && (
        <div className="preview-table">
          <h4>Preview ({preview.rowCount} rows · {formatMs(preview.executionTimeMs)})</h4>
          <table>
            <thead>
              <tr>
                {preview.columns.map((col) => <th key={col}>{col}</th>)}
              </tr>
            </thead>
            <tbody>
              {preview.rows.slice(0, 5).map((row, idx) => (
                <tr key={idx}>
                  {preview.columns.map((col) => <td key={col}>{String(row[col] ?? '')}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Action Buttons */}
      <button 
        onClick={() => setCheckpoint(selectedNode.id, 'checkpoint-label')}
        disabled={Boolean(selectedNode.checkpoint_id)}
      >
        {selectedNode.checkpoint_id ? 'Checkpoint Pinned' : 'Set Checkpoint'}
      </button>
    </div>
  );
}
```

---

### Recipe B: Step 4 — Checkpoint & Recovery Modal
Replaces legacy `window.prompt()` with a typed, schema-aware dialog.

```jsx
import { useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { columnsFor } from '@/lib/schema';
import { CORRECTABLE_ACTION_TYPES, OPERATORS } from '@/constants/backend';

export function RecomputeModal({ isOpen, onClose, targetNode }) {
  const { recover, checkpointsForState, setCheckpoint } = useSession();
  const [actionType, setActionType] = useState('FILTER');
  const [column, setColumn] = useState('gpa');
  const [operator, setOperator] = useState('>');
  const [value, setValue] = useState('8.5');

  const availableColumns = columnsFor(['students', 'courses']);

  const handleApply = async () => {
    // 1. Resolve checkpoint on node (or create one automatically)
    let cp = checkpointsForState.get(targetNode.id);
    if (!cp) {
      cp = await setCheckpoint(targetNode.id, 'auto-recovery-base');
    }

    // 2. Build structured correction payload
    const correction = {
      action_type: actionType,
      parameters: actionType === 'FILTER' 
        ? { column, operator, value: Number(value) || value }
        : { limit: Number(value) || 5 }
    };

    // 3. Dispatch recovery branch
    await recover({ checkpointId: cp.id, action: correction });
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal-content">
        <h3>Branch / Recompute from {targetNode.action}</h3>

        <label>Correction Action</label>
        <select value={actionType} onChange={(e) => setActionType(e.target.value)}>
          {CORRECTABLE_ACTION_TYPES.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>

        {actionType === 'FILTER' && (
          <>
            <label>Column</label>
            <select value={column} onChange={(e) => setColumn(e.target.value)}>
              {availableColumns.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>

            <label>Operator</label>
            <select value={operator} onChange={(e) => setOperator(e.target.value)}>
              {OPERATORS.map((op) => <option key={op} value={op}>{op}</option>)}
            </select>

            <label>Value</label>
            <input value={value} onChange={(e) => setValue(e.target.value)} />
          </>
        )}

        <button onClick={handleApply}>Branch & Apply Correction</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
```

---

### Recipe C: Step 5 — Final Results & SQL Tabs

```jsx
import { useQueryRun } from '@/hooks/useQueryRun';
import { formatMs } from '@/lib/format';

export function BottomResultsPanel() {
  const { result, isFinished } = useQueryRun();

  if (!isFinished || !result) {
    return <div>Run query to completion to view final records</div>;
  }

  return (
    <div className="results-panel">
      <div>
        <h4>Compiled Final SQL</h4>
        <pre>{result.sql}</pre>
      </div>

      <div>
        <h4>Results ({result.rowCount} rows in {formatMs(result.executionTimeMs)})</h4>
        <table>
          <thead>
            <tr>
              {result.columns.map((col) => <th key={col}>{col}</th>)}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, idx) => (
              <tr key={idx}>
                {result.columns.map((col) => <td key={col}>{String(row[col] ?? '')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

---

## 6. Error Handling Guide

All errors thrown or reported in `session.error` or `run.error` are instances of `ApiError`:

```javascript
import { API_ERROR } from '@/api/errors';

if (session.error) {
  switch (session.error.code) {
    case API_ERROR.BACKEND_OFFLINE:
      // Show "Backend offline at http://localhost:8000" banner
      break;
    case API_ERROR.UNPROCESSABLE:
      // Highlighting input fields listed in session.error.fields
      break;
    case API_ERROR.NO_CHECKPOINT:
      // Prompt user to pin a checkpoint before attempting recovery
      break;
    default:
      // Show session.error.message
  }
}
```
