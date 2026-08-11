# Surreal Vector (Qdrant-compatible RAG bridge)

Open WebUI does **not** ship a native `VECTOR_DB=surrealdb` backend (upstream
declined that integration). This service exposes a **Qdrant-compatible HTTP API**
backed by **SurrealDB HNSW** indexes so ODS RAG can store chunks in Surreal —
browsable in [Surrealist](https://surrealist.app/).

```
Open WebUI  --(Qdrant client)-->  surreal-vector  -->  SurrealDB (HNSW)
     ^                                                     ^
     | embeddings via TEI                                  |
     +---------------- ODS embeddings ----------------------+
```

## Requirements

- `surrealdb` library extension enabled
- ODS embeddings service (default TEI / `BAAI/bge-base-en-v1.5`, **768 dims**)

## Enable

```bash
ods enable surrealdb
ods enable surreal-vector
```

Then point Open WebUI at the bridge (compose overlay or `.env`):

```bash
# merge compose.open-webui.yaml into your stack flags, or set:
VECTOR_DB=qdrant
QDRANT_URI=http://surreal-vector:6333
QDRANT_API_KEY=<same as SURREAL_VECTOR_API_KEY / QDRANT_API_KEY>
QDRANT_PREFER_GRPC=false
```

Restart Open WebUI after changing vector settings. **Re-index documents** —
existing Chroma/Qdrant collections are not migrated.

## Access

| | |
|---|---|
| Bridge (host) | `http://127.0.0.1:6335` |
| Surrealist | connect to SurrealDB; NS `ods` / DB `rag` |
| Tables | `collection_registry`, `c_<collection>` |

### Surrealist peek

```sql
USE NS ods DB rag;
SELECT * FROM collection_registry;
SELECT point_id, text, metadata FROM c_open_webui_knowledge LIMIT 5;
```

## Environment

| Variable | Default | Description |
|---|---|---|
| `SURREAL_VECTOR_PORT` | `6335` | Host port (avoids clash with real Qdrant on 6333) |
| `SURREALDB_URL` | `http://surrealdb:8000` | Surreal from inside Docker |
| `SURREALDB_USER` / `SURREALDB_PASS` | from `surrealdb` setup | Auth |
| `SURREAL_VECTOR_NS` / `SURREAL_VECTOR_DB` | `ods` / `rag` | Surreal location |
| `SURREAL_VECTOR_DEFAULT_DIM` | `768` | BGE-base dimension |
| `SURREAL_VECTOR_API_KEY` | optional | Mirrored as Qdrant API key |

## Notes

- Implements the Open WebUI `qdrant_client` subset (collections + points upsert/query/scroll/delete).
- Not a full Qdrant replacement — n8n Qdrant nodes may need the real `qdrant` service.
- Keep real Qdrant enabled if other tools still target `:6333`.
EOF
