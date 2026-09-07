"""Host-owned provider Settings. Saving is not runtime activation."""

from pathlib import Path
import os

from .config import default_config, public_config
from .vault import CredentialStore, validate_edit
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
    body = validate_edit(body)
    directory = _directory(data_dir)
    # No recursive mkdir/chmod or silent repair of existing state. The install's
    # data directory must already exist. Store checks custody before any write.
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError:
        pass
    return CredentialStore(directory).save_public(body)
