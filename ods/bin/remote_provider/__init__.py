"""Remote provider support package.

This package is intentionally stdlib-only so installer, host-agent, and future
egress-service code can share the same contract without adding runtime deps.
"""

from .policy import (  # noqa: F401
    ACTIVATION_RECEIPT_SCHEMA,
    DEFAULT_POLICY_PATH,
    FORBIDDEN_PUBLIC_SECRET_ENV,
    INTERNAL_EGRESS_BASE_URL,
    PUBLIC_MODEL_ALIAS,
    REDACTED,
    REMOTE_ROUTE_SCHEMA,
    SCHEMA,
    PolicyError,
    load_policy,
    normalize_provider_base_url,
    plan_route,
    public_activation_receipt,
    redacted_secret_refs,
    validate_public_env_keys,
    validate_remote_model_id,
)

__all__ = [
    "ACTIVATION_RECEIPT_SCHEMA",
    "DEFAULT_POLICY_PATH",
    "FORBIDDEN_PUBLIC_SECRET_ENV",
    "INTERNAL_EGRESS_BASE_URL",
    "PUBLIC_MODEL_ALIAS",
    "REDACTED",
    "REMOTE_ROUTE_SCHEMA",
    "SCHEMA",
    "PolicyError",
    "load_policy",
    "normalize_provider_base_url",
    "plan_route",
    "public_activation_receipt",
    "redacted_secret_refs",
    "validate_public_env_keys",
    "validate_remote_model_id",
]
