import os
from typing import List

import uvicorn
from api.queries import router as query_router
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware


def create_app() -> FastAPI:
    app = FastAPI(
        title="Traceable Query Execution Platform",
        version="0.1.0",
        description=(
            "Typed, validated, observable, and recoverable "
            "database query execution."
        ),
    )

    # CORS: Starlette rejects `allow_origins=["*"]` together with
    # `allow_credentials=True` as an insecure config (any origin could read
    # credentialed cross-origin data). Use an explicit allowlist instead.
    # Override via the comma-separated `CORS_ORIGINS` env var in production;
    # defaults to a permissive-but-explicit dev allowlist (Vite's default port).
    def _cors_origins() -> List[str]:
        raw = os.environ.get("CORS_ORIGINS")
        if not raw:
            return ["http://localhost:5173", "http://127.0.0.1:5173"]
        return [origin.strip() for origin in raw.split(",") if origin.strip()]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(query_router)

    @app.get(
        "/health",
        tags=["system"],
    )
    def health() -> dict[str, str]:
        return {
            "status": "ok",
        }

    return app


app = create_app()


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
