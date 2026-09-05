import asyncio
import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, MagicMock

# Mocking dependencies
import sys
from unittest.mock import patch

# We need to mock the router and its dependencies before importing
# Since the actual router depends on config and security, we mock them.
with (
    patch("config.DATA_DIR", "/tmp/ods"),
    patch("security.verify_api_key", lambda x: x),
):
    from routers import remote_provider_status

app = FastAPI()
app.include_router(remote_provider_status.router)
client = TestClient(app)


@pytest.mark.asyncio
async def test_probe_nonblocking():
    """
    Verify that a slow /api/remote-provider/probe request does not block
    other concurrent requests to the API.
    """
    # Mock _post_egress_probe to be slow
    # Mock _record_egress_probe_proof to be fast

    with (
        patch(
            "routers.remote_provider_status._post_egress_probe",
            new_callable=AsyncMock,
        ) as mock_probe,
        patch(
            "routers.remote_provider_status._record_egress_probe_proof",
            new_callable=AsyncMock,
        ) as mock_proof,
    ):

        async def slow_probe():
            await asyncio.sleep(2)
            return {"ok": True, "transport": "https"}

        mock_probe.side_effect = slow_probe
        mock_proof.return_value = {"recorded": True}

        # We use asyncio.gather to run a slow probe and a fast heartbeat/status check concurrently
        # Since TestClient is synchronous, we'll use an AsyncClient for this specific test
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as async_client:
            # Start a slow probe
            probe_task = asyncio.create_task(
                async_client.post("/api/remote-provider/probe")
            )

            # Give it a moment to start and hit the sleep
            await asyncio.sleep(0.1)

            # Immediately trigger a status check (which should be fast)
            # Mock _fetch_egress_health and _fetch_ssh_supervisor_status to be fast
            with (
                patch(
                    "routers.remote_provider_status._fetch_egress_health",
                    new_callable=AsyncMock,
                ) as mock_health,
                patch(
                    "routers.remote_provider_status._fetch_ssh_supervisor_status",
                    new_callable=AsyncMock,
                ) as mock_ssh,
            ):
                mock_health.return_value = {"reachable": True, "ready": True}
                mock_ssh.return_value = {"ready": True}

                status_start = asyncio.get_event_loop().time()
                status_resp = await async_client.get("/api/remote-provider/status")
                status_end = asyncio.get_event_loop().time()

                assert status_resp.status_code == 200
                # Status check should have finished almost instantly despite the slow probe
                assert (status_end - status_start) < 0.5

            probe_resp = await probe_task
            assert probe_resp.status_code == 200
