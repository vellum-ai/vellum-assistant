import pytest
from httpx import ASGITransport, AsyncClient

from vembda_assistant_server.app import app


@pytest.mark.asyncio
async def test_healthz__returns_ok() -> None:
    """Tests that the healthz endpoint returns a 200 with status ok."""

    # GIVEN a test client for the app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # WHEN we request the healthz endpoint
        response = await client.get("/healthz")

    # THEN we should get a 200 response
    assert response.status_code == 200

    # AND the body should indicate the service is ok
    assert response.json() == {"status": "ok"}
