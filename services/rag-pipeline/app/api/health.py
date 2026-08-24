"""Health and readiness endpoints with the canonical Axiom health body."""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()


@router.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok", "service": "axiom-rag-pipeline", "version": _version()}


@router.get("/readyz")
async def readyz() -> dict[str, str]:
    # Phase 2 (R2/R4): verify Qdrant + Redis reachability here.
    return {"status": "ok", "service": "axiom-rag-pipeline", "version": _version()}


def _version() -> str:
    return "0.1.0"
