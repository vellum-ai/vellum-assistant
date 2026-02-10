from fastapi import FastAPI

app = FastAPI(title="Vembda Assistant Server")


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}
