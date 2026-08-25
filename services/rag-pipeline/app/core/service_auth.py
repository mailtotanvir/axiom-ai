"""Service authentication (R5): structural tenant binding.

Every knowledge request must carry
  X-Axiom-Tenant:  <tenant id>
  X-Axiom-Signature: t=<unix>,v1=<hex>
where the signature is HMAC-SHA256(AXIOM_INTER_SERVICE_SECRET,
"<t>.<sha256(raw body)>.<tenant>") — same family as webhook signing, but
binding the tenant claim into the canonical string so a signature cannot be
replayed across tenants.

The tenant identity comes ONLY from this verified header. Any tenant field
in the JSON body is ignored for authorization (and rejected when it
conflicts), which is what makes the cross-tenant red-team suite pass.
"""

from __future__ import annotations

import hashlib
import hmac as hmac_mod
from dataclasses import dataclass

from fastapi import Request


class ServiceAuthError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        super().__init__(message)


@dataclass(frozen=True)
class VerifiedTenant:
    tenant_id: str
    project_id: str | None


def compute_signature(secret: str, timestamp: int, body_bytes: bytes, tenant_id: str) -> str:
    body_hash = hashlib.sha256(body_bytes).hexdigest()
    canonical = f"{timestamp}.{body_hash}.{tenant_id}"
    import hmac as h

    return h.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()


def parse_signature_header(header: str) -> tuple[int | None, str | None]:
    timestamp: int | None = None
    signature: str | None = None
    for part in header.split(","):
        if "=" not in part:
            return None, None
        key, _, value = part.strip().partition("=")
        if key == "t":
            try:
                timestamp = int(value)
            except ValueError:
                return None, None
        elif key == "v1":
            signature = value.lower()
    if timestamp is None or signature is None:
        return None, None
    return timestamp, signature


async def verify_service_tenant(
    request: Request, secret: str, tolerance_seconds: int = 300
) -> VerifiedTenant:
    raw_body = await request.body()
    tenant_id = request.headers.get("x-axiom-tenant", "")
    header = request.headers.get("x-axiom-signature", "")

    if not tenant_id or not header or not secret:
        raise ServiceAuthError(401, "AXIOM_UNAUTHENTICATED", "missing service credentials")

    timestamp, signature = parse_signature_header(header)
    import time

    now = int(time.time())
    stale = timestamp is None or abs(now - timestamp) > tolerance_seconds
    if stale:
        raise ServiceAuthError(
            401, "AXIOM_UNAUTHENTICATED", "stale or malformed signature timestamp"
        )

    if timestamp is None:
        raise ServiceAuthError(401, "AXIOM_UNAUTHENTICATED", "malformed signature timestamp")
    expected = compute_signature(secret, timestamp, raw_body, tenant_id)
    verified = hmac_mod.compare_digest(expected, signature or "")
    if not verified:
        raise ServiceAuthError(403, "AXIOM_FORBIDDEN_TENANT", "signature verification failed")

    # Optional project hint rides in a plain header (not security-critical;
    # document scoping still happens per tenant).
    project_id = request.headers.get("x-axiom-project") or None

    # Body tenant conflicts are rejected outright.
    if raw_body:
        import json

        try:
            payload = json.loads(raw_body)
            if isinstance(payload, dict):
                body_tenant = payload.get("tenant_id")
                mismatch = isinstance(body_tenant, str) and body_tenant and body_tenant != tenant_id
                if mismatch:
                    raise ServiceAuthError(
                        403,
                        "AXIOM_FORBIDDEN_TENANT",
                        "body tenant does not match credentials",
                    )
        except json.JSONDecodeError:
            raise ServiceAuthError(400, "AXIOM_VALIDATION_FAILED", "body must be JSON") from None

    return VerifiedTenant(tenant_id=tenant_id, project_id=project_id)
