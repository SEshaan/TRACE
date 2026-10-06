from __future__ import annotations

import os
import sys
from pathlib import Path

# Add project root and Backend to path
WORKSPACE_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(WORKSPACE_ROOT))
sys.path.insert(0, str(WORKSPACE_ROOT / "Backend"))

from Backend.db_adapters.sqlite_adapter import SQLiteAdapter
from Backend.handlers import (
    AgentController,
    DefaultQueryStateEngine,
    DeterministicValidator,
    InMemoryTraceStore,
    QueryHandler,
    SQLiteCompiler,
    SQLiteDatabaseAdapter,
    SQLiteSchemaProvider,
)
from Backend.ml_adapters.ornith_decision_model import OrnithDecisionModel


def main():
    db_path = WORKSPACE_ROOT / "Backend" / "db_adapters" / "test" / "test.sqlite"
    print(f"[*] Database path: {db_path}")

    sqlite_adapter = SQLiteAdapter(str(db_path))
    schema_provider = SQLiteSchemaProvider(sqlite_adapter)
    schema = schema_provider.get_schema()
    print(f"[*] Available tables in DB: {[t.name for t in schema.tables]}")

    # Set up Ornith decision model targeting loaded LM Studio model 'ornith-1.5-9b'
    print("[*] Initializing OrnithDecisionModel with 'ornith-1.5-9b' at http://localhost:1234/v1 ...")
    ornith_model = OrnithDecisionModel(
        model="ornith-1.5-9b",
        base_url="http://localhost:1234/v1",
        temperature=0.0,
    )

    controller = AgentController(default_agent="ornith")
    controller.register("ornith", ornith_model)
    controller.switch_to("ornith")

    handler = QueryHandler(
        decision_model=controller,
        state_engine=DefaultQueryStateEngine(),
        validator=DeterministicValidator(),
        compiler=SQLiteCompiler(),
        database=SQLiteDatabaseAdapter(sqlite_adapter),
        trace_store=InMemoryTraceStore(),
        schema_provider=schema_provider,
        preview_limit=10,
    )

    prompt = "Find all students who have a GPA greater than 8.5"
    print(f"\n=======================================================")
    print(f"[PROMPT] '{prompt}'")
    print(f"=======================================================\n")

    session = handler.create(prompt)
    print(f"[SESSION CREATED] ID: {session.id}, Status: {session.status}")

    step = 1
    max_steps = 6

    while step <= max_steps:
        print(f"\n--- Step {step}: Asking Decision Agent for next action ---")
        try:
            action = handler.next_action(session.id)
            print(f"[AGENT DECISION]")
            print(f"  Action Type: {action.action_type}")
            print(f"  Confidence : {getattr(action, 'confidence', 1.0):.2f}")
            print(f"  Parameters : {action.to_dict()}")

            if action.action_type == "FINISH":
                print("\n[+] Agent decided to FINISH query construction.")
                break

            print("\n--- Applying action to QueryHandler (Validation -> State -> Compiler -> DB Preview) ---")
            result = handler.apply_action(session.id, action)
            if not result.success:
                print(f"[-] Action Failed! Code: {result.failure.code}, Message: {result.failure.message}")
                break

            print(f"[+] Action Success!")
            print(f"  Generated SQL: {result.state.sql}")
            if result.preview:
                print(f"  Rows Returned: {result.preview.row_count}")
                print(f"  Columns      : {result.preview.columns}")
                print(f"  Preview Rows : {result.preview.rows[:3]}")

            step += 1

        except Exception as e:
            print(f"[-] Error during step {step}: {e}")
            import traceback
            traceback.print_exc()
            break

    # Execute final query
    print("\n=======================================================")
    print("[FINAL EXECUTION]")
    try:
        final_result = handler.finish(session.id)
        print(f"Final SQL:\n{final_result.sql}\n")
        print(f"Total Rows: {final_result.row_count}")
        print(f"Columns   : {final_result.columns}")
        print("Data:")
        for r in final_result.rows:
            print(f"  {r}")
    except Exception as e:
        print(f"Finish failed: {e}")

    # Inspect trace
    trace = handler.get_trace(session.id)
    print(f"\n[TRACE STORE] Total states recorded: {len(trace.states)}")


if __name__ == "__main__":
    main()
