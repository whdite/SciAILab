from __future__ import annotations

import uvicorn

from research_runtime.settings import load_settings


def main() -> None:
    settings = load_settings()
    uvicorn.run(
        "research_runtime.api.app:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )


if __name__ == "__main__":
    main()
