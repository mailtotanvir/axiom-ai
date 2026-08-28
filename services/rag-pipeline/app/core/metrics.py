"""Prometheus metrics registry and instrumentation for RAG pipeline (Milestone 5.1).

Exports standard OpenMetrics / Prometheus text at /metrics.
"""

from __future__ import annotations

import threading
from collections.abc import Mapping
from typing import ClassVar

Labels = Mapping[str, object]


def _format_labels(labels: Labels | None) -> str:
    if not labels:
        return ""
    pairs = [
        f'{k}="{str(v).replace(chr(92), chr(92)+chr(92)).replace(chr(34), chr(92)+chr(34))}"'
        for k, v in sorted(labels.items())
        if v is not None
    ]
    return f"{{{','.join(pairs)}}}" if pairs else ""


def _labels_key(labels: Labels | None) -> str:
    if not labels:
        return ""
    return ",".join(f"{k}={v}" for k, v in sorted(labels.items()))


class Counter:
    def __init__(self, name: str, help_text: str) -> None:
        self.name = name
        self.help_text = help_text
        self._lock = threading.Lock()
        self._values: dict[str, tuple[float, Labels | None]] = {}

    def inc(self, labels: Labels | None = None, value: float = 1.0) -> None:
        if value < 0:
            raise ValueError("Counter value must be non-negative")
        key = _labels_key(labels)
        with self._lock:
            current, _ = self._values.get(key, (0.0, labels))
            self._values[key] = (current + value, labels)

    def get(self, labels: Labels | None = None) -> float:
        key = _labels_key(labels)
        with self._lock:
            val, _ = self._values.get(key, (0.0, None))
            return val

    def to_prometheus(self) -> str:
        lines = [
            f"# HELP {self.name} {self.help_text}",
            f"# TYPE {self.name} counter",
        ]
        with self._lock:
            if not self._values:
                lines.append(f"{self.name} 0")
            else:
                for val, labels in self._values.values():
                    int_or_float = int(val) if val.is_integer() else val
                    lines.append(f"{self.name}{_format_labels(labels)} {int_or_float}")
        return "\n".join(lines)


class Gauge:
    def __init__(self, name: str, help_text: str) -> None:
        self.name = name
        self.help_text = help_text
        self._lock = threading.Lock()
        self._values: dict[str, tuple[float, Labels | None]] = {}

    def set(self, value: float, labels: Labels | None = None) -> None:
        key = _labels_key(labels)
        with self._lock:
            self._values[key] = (value, labels)

    def inc(self, labels: Labels | None = None, value: float = 1.0) -> None:
        key = _labels_key(labels)
        with self._lock:
            current, _ = self._values.get(key, (0.0, labels))
            self._values[key] = (current + value, labels)

    def dec(self, labels: Labels | None = None, value: float = 1.0) -> None:
        key = _labels_key(labels)
        with self._lock:
            current, _ = self._values.get(key, (0.0, labels))
            self._values[key] = (current - value, labels)

    def get(self, labels: Labels | None = None) -> float:
        key = _labels_key(labels)
        with self._lock:
            val, _ = self._values.get(key, (0.0, None))
            return val

    def to_prometheus(self) -> str:
        lines = [
            f"# HELP {self.name} {self.help_text}",
            f"# TYPE {self.name} gauge",
        ]
        with self._lock:
            if not self._values:
                lines.append(f"{self.name} 0")
            else:
                for val, labels in self._values.values():
                    int_or_float = int(val) if val.is_integer() else val
                    lines.append(f"{self.name}{_format_labels(labels)} {int_or_float}")
        return "\n".join(lines)


DEFAULT_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0)


class Histogram:
    def __init__(
        self,
        name: str,
        help_text: str,
        buckets: tuple[float, ...] = DEFAULT_BUCKETS,
    ) -> None:
        self.name = name
        self.help_text = help_text
        self.buckets = tuple(sorted(buckets))
        self._lock = threading.Lock()
        self._states: dict[str, dict[str, object]] = {}

    def observe(self, value: float, labels: Labels | None = None) -> None:
        key = _labels_key(labels)
        with self._lock:
            state = self._states.get(key)
            if state is None:
                state = {
                    "count": 0,
                    "sum": 0.0,
                    "buckets": [0] * len(self.buckets),
                    "labels": labels,
                }
                self._states[key] = state

            state["count"] = int(state["count"]) + 1  # type: ignore[index]
            state["sum"] = float(state["sum"]) + value  # type: ignore[index]
            bucket_counts = state["buckets"]
            assert isinstance(bucket_counts, list)
            for i, bound in enumerate(self.buckets):
                if value <= bound:
                    bucket_counts[i] += 1

    def to_prometheus(self) -> str:
        lines = [
            f"# HELP {self.name} {self.help_text}",
            f"# TYPE {self.name} histogram",
        ]
        with self._lock:
            if not self._states:
                for b in self.buckets:
                    lines.append(f'{self.name}_bucket{{le="{b}"}} 0')
                lines.append(f'{self.name}_bucket{{le="+Inf"}} 0')
                lines.append(f"{self.name}_sum 0")
                lines.append(f"{self.name}_count 0")
            else:
                for state in self._states.values():
                    base_labels = state["labels"] if isinstance(state["labels"], Mapping) else {}
                    bucket_counts = state["buckets"]
                    assert isinstance(bucket_counts, list)
                    for i, bound in enumerate(self.buckets):
                        lbls = {**base_labels, "le": bound}
                        lines.append(f"{self.name}_bucket{_format_labels(lbls)} {bucket_counts[i]}")
                    inf_lbls = {**base_labels, "le": "+Inf"}
                    lines.append(f"{self.name}_bucket{_format_labels(inf_lbls)} {state['count']}")
                    lines.append(f"{self.name}_sum{_format_labels(base_labels)} {state['sum']}")
                    lines.append(f"{self.name}_count{_format_labels(base_labels)} {state['count']}")
        return "\n".join(lines)


class MetricsRegistry:
    _instance: ClassVar[MetricsRegistry | None] = None

    def __init__(self) -> None:
        self.counters: dict[str, Counter] = {}
        self.gauges: dict[str, Gauge] = {}
        self.histograms: dict[str, Histogram] = {}
        self._lock = threading.Lock()

    def register_counter(self, name: str, help_text: str) -> Counter:
        with self._lock:
            if name not in self.counters:
                self.counters[name] = Counter(name, help_text)
            return self.counters[name]

    def register_gauge(self, name: str, help_text: str) -> Gauge:
        with self._lock:
            if name not in self.gauges:
                self.gauges[name] = Gauge(name, help_text)
            return self.gauges[name]

    def register_histogram(
        self,
        name: str,
        help_text: str,
        buckets: tuple[float, ...] = DEFAULT_BUCKETS,
    ) -> Histogram:
        with self._lock:
            if name not in self.histograms:
                self.histograms[name] = Histogram(name, help_text, buckets)
            return self.histograms[name]

    def get_metrics_text(self) -> str:
        parts: list[str] = []
        with self._lock:
            for c in self.counters.values():
                parts.append(c.to_prometheus())
            for g in self.gauges.values():
                parts.append(g.to_prometheus())
            for h in self.histograms.values():
                parts.append(h.to_prometheus())
        return "\n\n".join(parts) + "\n"

    def clear(self) -> None:
        with self._lock:
            self.counters.clear()
            self.gauges.clear()
            self.histograms.clear()


registry = MetricsRegistry()

# Shared platform metrics
http_server_request_duration_seconds = registry.register_histogram(
    "http_server_request_duration_seconds",
    "HTTP server request duration in seconds",
)
http_server_requests_total = registry.register_counter(
    "http_server_requests_total",
    "Total count of HTTP server requests",
)
http_server_requests_errors_total = registry.register_counter(
    "http_server_requests_errors_total",
    "Total count of HTTP server 5xx errors",
)
axiom_guardrail_pii_redactions_total = registry.register_counter(
    "axiom_guardrail_pii_redactions_total",
    "Total number of PII redactions performed during ingestion",
)


def record_request(method: str, route: str, status_code: int, duration_seconds: float) -> None:
    labels = {
        "job": "rag-pipeline",
        "method": method.upper(),
        "route": route or "unknown",
        "status": str(status_code),
    }
    http_server_request_duration_seconds.observe(duration_seconds, labels)
    http_server_requests_total.inc(labels)
    if status_code >= 500:
        http_server_requests_errors_total.inc({
            "job": "rag-pipeline",
            "method": method.upper(),
            "route": route or "unknown",
        })
