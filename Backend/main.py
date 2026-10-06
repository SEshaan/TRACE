from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.queries import router as query_router


def create_app() -> FastAPI:
    app = FastAPI(
        title="Traceable Query Execution Platform",
        version="0.1.0",
        description=(
            "Typed, validated, observable, and recoverable "
            "database query execution."
        ),
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
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
