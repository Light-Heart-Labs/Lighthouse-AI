"""Qdrant REST subset used by Open WebUI's qdrant_client, backed by SurrealDB."""

from __future__ import annotations

import os
from typing import Any, Optional

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import surreal

app = FastAPI(title="ODS Surreal Vector (Qdrant-compat)", version="0.1.0")

EXPECTED_KEY = os.environ.get("QDRANT_API_KEY") or os.environ.get("SURREAL_VECTOR_API_KEY") or ""
DEFAULT_DIM = int(os.environ.get("SURREAL_VECTOR_DEFAULT_DIM", "768"))


def _check_api_key(api_key: Optional[str]) -> None:
    if not EXPECTED_KEY:
        return
    if not api_key or api_key != EXPECTED_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


def surreal_value(value: Any) -> str:
    if value is None:
        return "NONE"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return f"'{surreal.esc(value)}'"
    if isinstance(value, list):
        return "[" + ", ".join(surreal_value(v) for v in value) + "]"
    if isinstance(value, dict):
        inner = ", ".join(f"{k}: {surreal_value(v)}" for k, v in value.items())
        return "{ " + inner + " }"
    return f"'{surreal.esc(str(value))}'"


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


@app.get("/")
async def root():
    return {"title": "ods-surreal-vector", "version": "0.1.0"}


@app.get("/readyz")
@app.get("/healthz")
async def ready():
    try:
        await surreal.ensure_namespace()
        return {"status": "ok"}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Collections
# ---------------------------------------------------------------------------


@app.get("/collections")
async def get_collections(api_key: Optional[str] = Header(default=None, alias="api-key")):
    _check_api_key(api_key)
    names = await surreal.list_collections()
    return {"result": {"collections": [{"name": n} for n in names]}, "status": "ok", "time": "0"}


@app.get("/collections/{name}/exists")
async def collection_exists(
    name: str, api_key: Optional[str] = Header(default=None, alias="api-key")
):
    _check_api_key(api_key)
    exists = await surreal.collection_exists(name)
    return {"result": {"exists": exists}, "status": "ok", "time": "0"}


@app.get("/collections/{name}")
async def get_collection(
    name: str, api_key: Optional[str] = Header(default=None, alias="api-key")
):
    _check_api_key(api_key)
    if not await surreal.collection_exists(name):
        raise HTTPException(status_code=404, detail=f"Collection `{name}` doesn't exist!")
    return {
        "result": {
            "status": "green",
            "optimizer_status": "ok",
            "vectors_count": None,
            "points_count": None,
            "config": {
                "params": {
                    "vectors": {"size": DEFAULT_DIM, "distance": "Cosine"},
                }
            },
        },
        "status": "ok",
        "time": "0",
    }


class VectorParams(BaseModel):
    size: int
    distance: str = "Cosine"
    on_disk: Optional[bool] = None


class CreateCollectionBody(BaseModel):
    vectors: VectorParams | dict[str, Any]
    hnsw_config: Optional[dict[str, Any]] = None


@app.put("/collections/{name}")
async def create_collection(
    name: str,
    body: CreateCollectionBody,
    api_key: Optional[str] = Header(default=None, alias="api-key"),
):
    _check_api_key(api_key)
    vectors = body.vectors
    if isinstance(vectors, VectorParams):
        dim = vectors.size
    else:
        dim = int(vectors.get("size") or DEFAULT_DIM)
    await surreal.register_collection(name, dim)
    return {"result": True, "status": "ok", "time": "0"}


@app.delete("/collections/{name}")
async def delete_collection(
    name: str, api_key: Optional[str] = Header(default=None, alias="api-key")
):
    _check_api_key(api_key)
    await surreal.drop_collection(name)
    return {"result": True, "status": "ok", "time": "0"}


@app.put("/collections/{name}/index")
async def create_payload_index(
    name: str,
    request: Request,
    api_key: Optional[str] = Header(default=None, alias="api-key"),
):
    """Open WebUI creates payload indexes; Surreal schemaless object fields need none."""
    _check_api_key(api_key)
    if not await surreal.collection_exists(name):
        raise HTTPException(status_code=404, detail=f"Collection `{name}` doesn't exist!")
    await request.json()
    return {"result": True, "status": "ok", "time": "0"}


# ---------------------------------------------------------------------------
# Points
# ---------------------------------------------------------------------------


class Point(BaseModel):
    id: Any
    vector: list[float]
    payload: Optional[dict[str, Any]] = None


class UpsertBody(BaseModel):
    points: list[Point] = Field(default_factory=list)


@app.put("/collections/{name}/points")
async def upsert_points(
    name: str,
    body: UpsertBody,
    api_key: Optional[str] = Header(default=None, alias="api-key"),
):
    _check_api_key(api_key)
    if not body.points:
        return {"result": {"status": "ok"}, "status": "ok", "time": "0"}
    if not await surreal.collection_exists(name):
        await surreal.register_collection(name, len(body.points[0].vector))
    # Rewrite upsert to use proper object literals
    table = surreal.table_name(name)
    stmts: list[str] = []
    for point in body.points:
        pid = str(point.id)
        payload = point.payload or {}
        text = surreal.esc(str(payload.get("text") or ""))
        metadata = payload.get("metadata") or {}
        rid = f"{table}:`{surreal.esc(pid)}`"
        stmts.append(
            f"UPSERT {rid} SET point_id = '{surreal.esc(pid)}', text = '{text}', "
            f"metadata = {surreal_value(metadata)}, embedding = {surreal_value(point.vector)};"
        )
    batch = 40
    for i in range(0, len(stmts), batch):
        await surreal.sql("\n".join(stmts[i : i + batch]))
    return {"result": {"status": "completed"}, "status": "ok", "time": "0"}


class QueryBody(BaseModel):
    query: list[float] | dict[str, Any] | Any = None
    vector: Optional[list[float]] = None
    limit: Optional[int] = 10
    filter: Optional[dict[str, Any]] = None


@app.post("/collections/{name}/points/query")
async def query_points(
    name: str,
    body: QueryBody,
    api_key: Optional[str] = Header(default=None, alias="api-key"),
):
    _check_api_key(api_key)
    if not await surreal.collection_exists(name):
        raise HTTPException(status_code=404, detail=f"Collection `{name}` doesn't exist!")
    vector: list[float] | None = None
    if isinstance(body.query, list):
        vector = [float(x) for x in body.query]
    elif isinstance(body.query, dict) and "nearest" in body.query:
        nearest = body.query["nearest"]
        if isinstance(nearest, list):
            vector = [float(x) for x in nearest]
    elif body.vector:
        vector = [float(x) for x in body.vector]
    if not vector:
        # qdrant_client query_points often sends {"query": <vector>}
        raise HTTPException(status_code=400, detail="query vector required")
    limit = body.limit or 10
    points = await surreal.search_points(name, vector, limit=limit)
    return {
        "result": {
            "points": [
                {
                    "id": p["id"],
                    "version": 0,
                    "score": p["score"],
                    "payload": p["payload"],
                }
                for p in points
            ]
        },
        "status": "ok",
        "time": "0",
    }


class ScrollBody(BaseModel):
    limit: Optional[int] = 10
    filter: Optional[dict[str, Any]] = None
    offset: Optional[Any] = None
    with_payload: Optional[bool] = True
    with_vector: Optional[bool] = False


@app.post("/collections/{name}/points/scroll")
async def scroll_points(
    name: str,
    body: ScrollBody,
    api_key: Optional[str] = Header(default=None, alias="api-key"),
):
    _check_api_key(api_key)
    if not await surreal.collection_exists(name):
        return {"result": {"points": [], "next_page_offset": None}, "status": "ok", "time": "0"}
    should: list[dict[str, Any]] = []
    if body.filter:
        for cond in body.filter.get("should") or []:
            if "key" in cond and "match" in cond:
                should.append({"key": cond["key"], "value": cond["match"].get("value")})
            elif isinstance(cond, dict) and "FieldMap" not in cond:
                # tolerate FieldCondition-like dicts
                key = cond.get("key")
                match = cond.get("match") or {}
                if key is not None:
                    should.append({"key": key, "value": match.get("value")})
    points = await surreal.scroll_points(name, limit=body.limit or 10, filter_should=should or None)
    return {
        "result": {
            "points": [
                {"id": p["id"], "payload": p["payload"], "version": 0} for p in points
            ],
            "next_page_offset": None,
        },
        "status": "ok",
        "time": "0",
    }


class DeleteBody(BaseModel):
    points: Optional[list[Any]] = None
    filter: Optional[dict[str, Any]] = None


@app.post("/collections/{name}/points/delete")
async def delete_points(
    name: str,
    body: DeleteBody,
    api_key: Optional[str] = Header(default=None, alias="api-key"),
):
    _check_api_key(api_key)
    if not await surreal.collection_exists(name):
        return {"result": {"status": "ok"}, "status": "ok", "time": "0"}
    if body.points:
        await surreal.delete_points(name, ids=[str(x) for x in body.points])
    elif body.filter:
        must = []
        for cond in body.filter.get("must") or []:
            key = cond.get("key")
            match = cond.get("match") or {}
            if key is not None:
                must.append({"key": key, "value": match.get("value")})
        await surreal.delete_points(name, filter_must=must or None)
    return {"result": {"status": "ok"}, "status": "ok", "time": "0"}


@app.exception_handler(surreal.SurrealError)
async def surreal_error_handler(_request: Request, exc: surreal.SurrealError):
    return JSONResponse(status_code=500, content={"status": {"error": str(exc)}})
