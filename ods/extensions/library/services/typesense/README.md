# Typesense

Typesense provides low-latency typo-tolerant, federated, and vector search through a compact HTTP API. It is useful when an ODS app needs multi-collection queries or built-in vector/hybrid retrieval without bundling a search process of its own.

## Enable and access

```bash
ods enable typesense
ods start typesense
```

- API: `http://localhost:8108`
- Health: `http://localhost:8108/health`

The setup hook generates `TYPESENSE_API_KEY` once. Existing values are never replaced.

## Create a collection

```bash
curl -X POST http://localhost:8108/collections \
  -H "X-TYPESENSE-API-KEY: $TYPESENSE_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"name":"notes","fields":[{"name":"title","type":"string"}]}'
```

Applications should create scoped search-only keys through the Typesense key API instead of distributing the bootstrap administrator key.

## Operational defaults

The API is loopback-bound, administrator-key protected, CORS-disabled, capability-free, and read-only outside `data/typesense`. Typesense rejects new writes at 90% disk or memory use rather than exhausting the host.

## Upstream

- Project: <https://github.com/typesense/typesense>
- Documentation: <https://typesense.org/docs/>
