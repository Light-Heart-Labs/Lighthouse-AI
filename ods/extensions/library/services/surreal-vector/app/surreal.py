"""Minimal SurrealDB HTTP SQL client for the vector bridge."""

from __future__ import annotations

import json
import os
from typing import Any

import httpx

SURREALDB_URL = os.environ.get("SURREALDB_URL", "http://surrealdb:8000").rstrip("/")
SURREALDB_USER = os.environ.get("SURREALDB_USER", "root")
SURREALDB_PASS = os.environ.get("SURREALDB_PASS", "")
NS = os.environ.get("SURREAL_VECTOR_NS", "ods")
DB = os.environ.get("SURREAL_VECTOR_DB", "rag")


class SurrealError(RuntimeError):
    pass


def _headers() -> dict[str, str]:
    import base64

    token = base64.b64encode(f"{SURREALDB_USER}:{SURREALDB_PASS}".encode()).decode()
    return {
        "Authorization": f"Basic {token}",
        "Accept": "application/json",
        "Content-Type": "text/plain",
        "surreal-ns": NS,
        "surreal-db": DB,
    }


async def sql(query: str, timeout: float = 60.0) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(f"{SURREALDB_URL}/sql", content=query, headers=_headers())
        resp.raise_for_status()
        payload = resp.json()
    if not isinstance(payload, list):
        raise SurrealError(f"Unexpected Surreal response: {payload!r}")
    for row in payload:
        if row.get("status") != "OK":
            raise SurrealError(row.get("result") or row)
    return payload


def esc(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def table_name(collection: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in collection.lower())
    return f"c_{safe}"[:120] or "c_default"


async def ensure_namespace() -> None:
    # NS/DB may already exist; IGNORE-style DEFINE is fine.
    setup = f"""
DEFINE NAMESPACE IF NOT EXISTS {NS};
DEFINE DATABASE IF NOT EXISTS {DB};
"""
    # DEFINE DATABASE needs active NS — send as two requests if needed.
    async with httpx.AsyncClient(timeout=30.0) as client:
        auth = _headers()
        # root-level ns create (no db header required for DEFINE NS)
        ns_headers = {k: v for k, v in auth.items() if k not in {"surreal-ns", "surreal-db"}}
        await client.post(
            f"{SURREALDB_URL}/sql",
            content=f"DEFINE NAMESPACE IF NOT EXISTS {NS};",
            headers={**ns_headers, "Accept": "application/json", "Content-Type": "text/plain"},
        )
        await client.post(
            f"{SURREALDB_URL}/sql",
            content=f"DEFINE DATABASE IF NOT EXISTS {DB};",
            headers={
                **ns_headers,
                "Accept": "application/json",
                "Content-Type": "text/plain",
                "surreal-ns": NS,
            },
        )


async def ensure_collection(collection: str, dimension: int) -> None:
    await ensure_namespace()
    table = table_name(collection)
    # DEFINE ... IF NOT EXISTS varies by Surreal version; ignore already-defined errors.
    for stmt in (
        f"DEFINE TABLE IF NOT EXISTS {table} SCHEMALESS;",
        f"DEFINE FIELD IF NOT EXISTS point_id ON {table} TYPE string;",
        f"DEFINE FIELD IF NOT EXISTS text ON {table} TYPE string;",
        f"DEFINE FIELD IF NOT EXISTS metadata ON {table} TYPE object;",
        f"DEFINE FIELD IF NOT EXISTS embedding ON {table} TYPE array<float>;",
        (
            f"DEFINE INDEX IF NOT EXISTS {table}_hnsw ON {table} "
            f"FIELDS embedding HNSW DIMENSION {int(dimension)} DIST COSINE TYPE F32;"
        ),
        f"DEFINE INDEX IF NOT EXISTS {table}_point_id ON {table} FIELDS point_id UNIQUE;",
    ):
        try:
            await sql(stmt)
        except SurrealError as exc:
            msg = str(exc).lower()
            if "already" in msg or "exists" in msg:
                continue
            raise


async def list_collections() -> list[str]:
    await ensure_namespace()
    result = await sql("INFO FOR DB;")
    tables = (result[0].get("result") or {}).get("tables") or {}
    names = []
    for key in tables:
        if key.startswith("c_"):
            # reverse is lossy; store registry
            names.append(key)
    # Prefer registry table if present
    try:
        reg = await sql("SELECT name, table FROM collection_registry;")
        rows = reg[0].get("result") or []
        if rows:
            return [r["name"] for r in rows if r.get("name")]
    except SurrealError:
        pass
    return names


async def register_collection(collection: str, dimension: int) -> None:
    await ensure_namespace()
    await sql(
        """
DEFINE TABLE IF NOT EXISTS collection_registry SCHEMALESS;
DEFINE FIELD IF NOT EXISTS name ON collection_registry TYPE string;
DEFINE FIELD IF NOT EXISTS table ON collection_registry TYPE string;
DEFINE FIELD IF NOT EXISTS dimension ON collection_registry TYPE int;
DEFINE INDEX IF NOT EXISTS collection_registry_name ON collection_registry FIELDS name UNIQUE;
"""
    )
    table = table_name(collection)
    await sql(
        f"""
UPSERT collection_registry:`{esc(collection)}` SET
  name = '{esc(collection)}',
  table = '{table}',
  dimension = {int(dimension)};
"""
    )
    await ensure_collection(collection, dimension)


async def collection_exists(collection: str) -> bool:
    await ensure_namespace()
    try:
        result = await sql(
            f"SELECT name FROM collection_registry WHERE name = '{esc(collection)}' LIMIT 1;"
        )
        rows = result[0].get("result") or []
        return bool(rows)
    except SurrealError:
        return False


async def drop_collection(collection: str) -> None:
    table = table_name(collection)
    await sql(f"REMOVE TABLE IF EXISTS {table};")
    await sql(f"DELETE collection_registry WHERE name = '{esc(collection)}';")


def _vector_literal(vector: list[float]) -> str:
    return "[" + ", ".join(f"{float(x)}" for x in vector) + "]"


async def upsert_points(collection: str, points: list[dict[str, Any]]) -> None:
    if not points:
        return
    table = table_name(collection)
    stmts: list[str] = []
    for point in points:
        pid = str(point["id"])
        vector = point["vector"]
        payload = point.get("payload") or {}
        text = esc(str(payload.get("text") or ""))
        metadata = payload.get("metadata") or {}
        meta_json = esc(json.dumps(metadata, ensure_ascii=False))
        rid = f"{table}:`{esc(pid)}`"
        stmts.append(
            f"UPSERT {rid} SET point_id = '{esc(pid)}', text = '{text}', "
            f"metadata = type::object('{meta_json}'), embedding = {_vector_literal(vector)};"
        )
    # Batch to keep request size sane
    batch = 40
    for i in range(0, len(stmts), batch):
        await sql("\n".join(stmts[i : i + batch]))


async def search_points(
    collection: str, vector: list[float], limit: int = 10
) -> list[dict[str, Any]]:
    table = table_name(collection)
    limit = max(1, int(limit))
    effort = 40
    result = await sql(
        f"""
SELECT point_id, text, metadata, vector::distance::knn() AS dist
FROM {table}
WHERE embedding <|{limit}, {effort}|> {_vector_literal(vector)};
"""
    )
    rows = result[0].get("result") or []
    out = []
    for row in rows:
        dist = float(row.get("dist") or 0.0)
        # Cosine distance in Surreal → convert to similarity-ish score in [-1, 1] for Qdrant client
        score = 1.0 - dist
        out.append(
            {
                "id": row.get("point_id"),
                "payload": {"text": row.get("text") or "", "metadata": row.get("metadata") or {}},
                "score": score,
            }
        )
    return out


async def scroll_points(
    collection: str,
    limit: int = 10,
    filter_should: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    table = table_name(collection)
    limit = max(1, int(limit))
    where = ""
    if filter_should:
        clauses = []
        for cond in filter_should:
            key = cond.get("key") or ""
            value = cond.get("value")
            if key.startswith("metadata."):
                field = key.split(".", 1)[1]
                if isinstance(value, str):
                    clauses.append(f"metadata.{field} = '{esc(value)}'")
                else:
                    clauses.append(f"metadata.{field} = {json.dumps(value)}")
            elif key == "metadata.id":
                clauses.append(f"metadata.id = '{esc(str(value))}'")
        if clauses:
            where = "WHERE " + " OR ".join(clauses)
    result = await sql(f"SELECT point_id, text, metadata FROM {table} {where} LIMIT {limit};")
    rows = result[0].get("result") or []
    return [
        {
            "id": row.get("point_id"),
            "payload": {"text": row.get("text") or "", "metadata": row.get("metadata") or {}},
        }
        for row in rows
    ]


async def delete_points(
    collection: str,
    ids: list[str] | None = None,
    filter_must: list[dict[str, Any]] | None = None,
) -> None:
    table = table_name(collection)
    if ids:
        for pid in ids:
            await sql(f"DELETE {table} WHERE point_id = '{esc(str(pid))}';")
        return
    if filter_must:
        clauses = []
        for cond in filter_must:
            key = cond.get("key") or ""
            value = cond.get("value")
            if key.startswith("metadata."):
                field = key.split(".", 1)[1]
                if isinstance(value, str):
                    clauses.append(f"metadata.{field} = '{esc(value)}'")
                else:
                    clauses.append(f"metadata.{field} = {json.dumps(value)}")
        if clauses:
            await sql(f"DELETE {table} WHERE " + " AND ".join(clauses) + ";")
