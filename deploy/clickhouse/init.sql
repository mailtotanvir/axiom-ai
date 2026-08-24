-- Axiom AI ClickHouse schema (G6 metering; O1 traces land in Phase 4).

CREATE DATABASE IF NOT EXISTS axiom;

CREATE TABLE IF NOT EXISTS axiom.metering_usage_events
(
    timestamp            DateTime64(3, 'UTC'),
    request_id           String,
    tenant_id            LowCardinality(String),
    project_id           LowCardinality(String),
    model                LowCardinality(String),
    provider             LowCardinality(String),
    streamed             UInt8,
    prompt_tokens        UInt64,
    completion_tokens    UInt64,
    total_tokens         UInt64,
    usage_source         LowCardinality(String),
    reconciliation_delta Int64,
    cost_usd             Float64,
    latency_ms           UInt32,
    upstream_status      UInt16,
    -- Provider-native prompt caching (OpenAI cached_tokens, Anthropic
    -- cache_creation/cache_read).
    cached_input_tokens  UInt64 DEFAULT 0,
    cache_write_tokens   UInt64 DEFAULT 0,
    cache_read_tokens    UInt64 DEFAULT 0,
    -- Gateway-level exact-match input cache outcome.
    cache_hit            UInt8 DEFAULT 0
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, timestamp)
TTL toDateTime(timestamp) + INTERVAL 13 MONTH
SETTINGS index_granularity = 8192;
