"""Host-owned provider Settings. Saving is not runtime activation."""

from pathlib import Path
import os

from .config import ConfigError, default_config, normalize_config, public_config
from .store import ProviderStore, StoreError


def _directory(data_dir):
    if os.name != "posix":
        raise StoreError("unsupported-platform")
    return Path(data_dir) / "pixel-providers"


def get_configuration(data_dir):
    directory = _directory(data_dir)
    try:
        directory.lstat()
    except FileNotFoundError:
        # A pristine install has no feature state and requires no migration.
        return public_config(default_config())
    return public_config(ProviderStore(directory).load())


def save_configuration(data_dir, body):
    if (not isinstance(body, dict) or set(body) != {"document", "expectedRevision"}
            or type(body["expectedRevision"]) is not int
            or not 0 <= body["expectedRevision"] < 2**53 - 1
            or not isinstance(body["document"], dict)):
        raise StoreError("invalid-request")
    directory = _directory(data_dir)
    # No recursive mkdir/chmod or silent repair of existing state. The install's
    # data directory must already exist. Store checks custody before any write.
    try:
        document = normalize_config(body["document"])
    except ConfigError:
        raise StoreError("invalid-config") from None
    if document["revision"] != body["expectedRevision"]:
        raise StoreError("stale-revision")
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError:
        pass
    return public_config(ProviderStore(directory).save(
        document, expected_revision=body["expectedRevision"],
    ))
