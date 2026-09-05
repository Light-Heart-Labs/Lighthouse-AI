# Apache Tika

Apache Tika provides a local HTTP API for extracting text and metadata from PDFs, office documents, archives, email, images, audio, and more than a thousand other formats. The `full` image includes Tesseract OCR and common native parsers.

## Enable and access

```bash
ods enable apache-tika
ods start apache-tika
```

- API: `http://localhost:9998`
- Health/version endpoint: `http://localhost:9998/tika`

## Extract text

```bash
curl -T document.pdf \
  -H "Accept: text/plain" \
  http://localhost:9998/tika
```

## Extract metadata

```bash
curl -T document.pdf \
  -H "Accept: application/json" \
  http://localhost:9998/meta
```

Optional parser JARs can be placed under `data/apache-tika/extras`; the directory is mounted read-only at `/tika-extras` inside the container.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `APACHE_TIKA_PORT` | `9998` | Host port for the Tika API |

The service is loopback-bound by default. Standard ODS `BIND_ADDRESS` policy controls intentional LAN exposure.

## Upstream

- Project: <https://github.com/apache/tika>
- Container image: <https://github.com/apache/tika-docker>
