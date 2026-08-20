# Docling Serve

Docling Serve runs IBM's Docling document-conversion pipeline as a local API and browser playground. It extracts layout, tables, OCR text, and structured chunks without uploading source documents to a hosted parser.

## Enable and access

```bash
ods enable docling-serve
ods start docling-serve
```

- Playground: `http://localhost:5001/ui`
- OpenAPI: `http://localhost:5001/docs`
- Readiness: `http://localhost:5001/readyz`

The first start may take several minutes while the image initializes its document models. The CPU image works on every ODS backend and has a deliberately generous memory limit for OCR-heavy PDFs.

## Convert a document

```bash
curl -X POST http://localhost:5001/v1/convert/file \
  -H "accept: application/json" \
  -F "files=@document.pdf"
```

Remote URL conversion is also supported through `/v1/convert/source`. Only submit URLs you trust: the service, not your browser, fetches those resources.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `DOCLING_SERVE_PORT` | `5001` | Host port for the API and playground |
| `DOCLING_SERVE_ENABLE_UI` | `1` | Enables the browser playground |

The service is loopback-bound by default. Standard ODS `BIND_ADDRESS` policy controls intentional LAN exposure.

## Upstream

- Project: <https://github.com/docling-project/docling-serve>
- API documentation: <https://github.com/docling-project/docling-serve/blob/main/docs/README.md>
