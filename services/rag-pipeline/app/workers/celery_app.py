"""Celery application for ingestion workers (spec section 2, row 4).

Queues:
  ingest.parse   - Unstructured document parsing
  ingest.embed   - Batched embedding + Qdrant upsert

Phase 2 (R1/R2) implements the tasks; Phase 0 defines topology only.
"""

from __future__ import annotations

from celery import Celery

from app.core.config import get_settings


def create_celery_app() -> Celery:
    settings = get_settings()
    broker = settings.REDIS_PRIMARY_URL or "redis://localhost:6379/1"
    app = Celery("axiom-rag", broker=broker, backend=broker)
    app.conf.update(
        task_default_queue="ingest.parse",
        task_queues_ha_policy="all",
        task_acks_late=True,
        worker_prefetch_multiplier=1,
        task_track_started=True,
        broker_connection_retry_on_startup=True,
    )
    return app


celery_app = create_celery_app()
