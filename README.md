# dbthon — Traceable Query Execution Platform

A natural-language → SQL agent platform where **the LLM never writes SQL**. It emits
**typed actions** (`FILTER`, `JOIN`, …) that are **deterministically validated**, applied
to an **immutable state tree**, **compiled** to parameterized SQL, **executed as a bounded
preview**, and **persisted as a trace graph**. Failures are structured, states are
checkpointed, and recovery **branches** instead of mutating history.

The UI is a **React Flow graph of query states** with an inspector, checkpoint/recovery
workflow, and a results panel.

> This repo ships two independent suites: the Python backend (`pytest`) and the React
> frontend (`vitest`). Both are green on checkout — see [Testing](#testing).

---

## Architecture

```
dbthon/
├── Backend/                 FastAPI + uvicorn (Python 3.11)
│   ├── main.py              App factory: routes, CORS, /health probe
│   ├── api/queries.py       ALL routes + Pydantic DTOs + build_action() whitelist
│   ├── handlers/            Core dataclasses + orchestrators
│   │   ├── query_handler.py        QueryHandler orchestration (state tree)
│   │   ├── actions.py              8 frozen typed-action dataclasses
│   │   ├── validator.py            DeterministicValidator (schema/operator rules)
│   │   ├── state_engine.py         apply()/branch() over immutable states
│   │   ├── compiler.py             SQLiteCompiler: actions -> (sql, params)
│   │   ├── db_adapter.py           SQLiteDatabaseAdapter (ExecutionResult + timing)
│   │   ├── schema_provider.py      cached DatabaseSchema
│   │   ├── trace_store.py          TraceStore protocol + InMemoryTraceStore
│   │   ├── sqlite_trace_store.py   real persistence
│   │   ├── decision_model.py       RuleBasedDecisionModel (fallback)
│   │   └── agent_controller.py     swaps ornith/laya/rule at runtime
│   ├── db_adapters/         low-level sqlite3 wrapper, schema DDL, seed.sql
│   ├── ml_adapters/         Ornith/Laya decision agents (LLM clients)
│   └── test/                backend pytest suite
├── Frontend/               Vite + React 19 + @ark-ui/react (Park UI) + @xyflow/react
│   ├── src/App.jsx              graph UI: inspector, checkpoint/recovery, results
│   ├── src/hooks/useQueryExecution.js  execution loop + graph builders
│   ├── src/api/client.js        fetch wrappers to the backend API
│   ├── src/QueryActionNode.jsx  custom React Flow node (typed actions)
│   └── src/store/queryStore.js  query state store
├── start.bat                launches Backend (:8000) + `npm run dev` together
└── pytest.ini              backend test configuration
```

### Core invariants

- **The model never produces SQL.** `DecisionModel.decide() -> QueryAction` only.
- **Raw SQL is never accepted by any endpoint.** `build_action()` is an explicit whitelist;
  the code comment says *"Do not accept SQL or dynamically instantiate arbitrary classes from action_type."*
- **States are immutable + append-only.** Every successful action creates a *new* `QueryState`
  with `parent_id` → the trace is a tree.
- **Recovery never deletes.** `recover()` clones the checkpoint state into a new branch and
  applies the correction there.
- **Validation is deterministic.** No LLM, no fuzzy matching — see `DeterministicValidator`.

---

## Getting started

### Prerequisites

- Python ≥ 3.11 (developed on 3.11)
- Node.js ≥ 18 for the frontend

### Backend

```bash
cd Backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install <deps>                                   # dependencies go into the venv
```

Run the API server (uvicorn on `0.0.0.0:8000`, auto-reload):

```bash
python main.py
# → http://localhost:8000/docs   (interactive Swagger UI)
#    health probe:  http://localhost:8000/health
```

> NOTE: the backend has no committed dependency manifest yet. Pin versions into a
> `requirements.txt` before publishing to make installs reproducible.

```bash
python main.py
# → http://localhost:8000/docs   (interactive Swagger UI)
#    health probe:  http://localhost:8000/health
```

### Frontend

```bash
cd Frontend
npm install
npm run dev          # Panda CSS codegen + Vite dev server
```

Open the Vite preview URL and build a query-state graph that talks to the backend API.

### One-command launch (Windows)

`start.bat` opens two terminals: one running `python Backend/main.py`, the other `cd Frontend && npm run dev`.

---

## Testing

Both suites are green on checkout (**385 tests total**).

### Backend — pytest (+ coverage)

```bash
cd Backend
python -m pytest                 # full suite (see pytest.ini for testpaths)
python -m pytest --cov=api --cov-report=term-missing   # per-file coverage
```

- Test paths: `Backend/db_adapters/test`, `Backend/handlers/test`, `Backend/test`, `Backend/ml_adapters`.
- The CORS smoke tests (`test/main_cors.test.py`) assert the secure allowlist contract and need no fixture DB.

### Frontend — vitest

```bash
cd Frontend
npm test                       # vitest run (React component + hook tests)
npx vitest run --coverage      # per-file coverage report
```

---

## CORS configuration

The backend uses an **explicit origin allowlist** for `CORSMiddleware` (`allow_credentials=True`).
It is **not** a wildcard — any non-whitelisted origin does not receive credentialed cross-origin access.

Override the allowed origins in production via a comma-separated environment variable:

```bash
# e.g. allow these specific origins (and nothing else):
CORS_ORIGINS="https://app.example.com,https://admin.example.com" python main.py
```

Defaults to `[http://localhost:5173, http://127.0.0.1:5173]` for local Vite development.

---

## Project structure & key files

| File | Purpose |
|------|---------|
| `Backend/main.py` | FastAPI app factory + CORS wiring + `/health`. |
| `Backend/api/queries.py` | All routes, Pydantic DTOs, and the action whitelist. |
| `Backend/handlers/query_handler.py` | Core state-tree orchestration. |
| `Backend/db_adapters/seeder/seed.sql` | Demo database schema + seed data. |
| `Frontend/src/App.jsx` | Graph UI (inspector, checkpoint/recovery, results). |
| `Frontend/src/hooks/useQueryExecution.js` | Execution loop and graph builders. |
| `Frontend/src/api/client.js` | Fetch wrappers to the backend API. |

---

## Specification & knowledge docs

The durable design specs live at repo root (kept in sync with this codebase):

- **`REPO_KNOWLEDGE.md`** — complete working memory of the project; read before touching the backend.
- **`FRONTEND_API_PLAN.md`** — frontend API contract and plan.
- **`FRONTEND_CLIENT_SPEC.md`** — client-side behavior spec.

> These are internal design documents, not user-facing docs. This README is the public entry point.

---

## License

See `LICENSE` (add if applicable).
