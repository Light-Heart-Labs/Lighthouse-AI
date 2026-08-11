"""Regression (#2351 bug 2): gemma4 catalog entries pinned a sha256 against
a `resolve/main` URL. Upstream (unsloth) updated the Q4_K_M files after the
sha was recorded, so every fresh install/repair verified the (genuinely
current, correctly-downloaded) file against a stale hash, deleted it,
re-downloaded the same file from `main`, got the same "mismatch" again, and
aborted in a loop — "file is corrupt. Re-run the installer" without the
file ever actually being corrupt.

Fix: pin gguf_url to the exact commit the recorded sha256 belongs to,
instead of the ever-moving `main` ref, so a future upstream update can't
silently invalidate the pinned checksum again.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "config" / "model-library.json"

# Verified directly against the HuggingFace API (GET .../tree/main, lfs.oid)
# at the time this fix was written.
EXPECTED = {
    "gemma4-e2b-q4": {
        "sha256": "740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8",
        "repo": "unsloth/gemma-4-E2B-it-GGUF",
    },
    "gemma4-e4b-q4": {
        "sha256": "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87",
        "repo": "unsloth/gemma-4-E4B-it-GGUF",
    },
}

REVISION_URL_RE = re.compile(
    r"^https://huggingface\.co/(?P<repo>[^/]+/[^/]+)/resolve/(?P<rev>[0-9a-f]{40})/(?P<file>.+)$"
)


def _catalog_by_id():
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    return {model["id"]: model for model in catalog["models"]}


def test_gemma4_entries_pin_a_specific_commit_not_main():
    by_id = _catalog_by_id()
    for model_id, expected in EXPECTED.items():
        model = by_id[model_id]
        url = model["gguf_url"]
        assert "/resolve/main/" not in url, (
            f"{model_id} still points at a moving 'main' ref: {url}"
        )
        match = REVISION_URL_RE.match(url)
        assert match, f"{model_id} gguf_url is not a pinned-revision HF URL: {url}"
        assert match.group("repo") == expected["repo"], (
            f"{model_id} gguf_url repo drifted: {match.group('repo')}"
        )
        assert match.group("file") == model["gguf_file"], (
            f"{model_id} gguf_url filename doesn't match gguf_file"
        )


def test_gemma4_checksums_match_the_pinned_revision():
    by_id = _catalog_by_id()
    for model_id, expected in EXPECTED.items():
        model = by_id[model_id]
        assert model["gguf_sha256"] == expected["sha256"], (
            f"{model_id} gguf_sha256 does not match the file at its pinned "
            f"revision (got {model['gguf_sha256']!r}, "
            f"expected {expected['sha256']!r})"
        )
