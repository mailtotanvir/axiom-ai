-- Axiom AI ClickHouse schema (G6 metering; O1 traces via collector exporter;
-- O3 eval results below).

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

-- Per-case metric rows for evaluation runs (O3). Column names are
-- snake_case per ClickHouse convention; the sink maps camelCase fields.
CREATE TABLE IF NOT EXISTS axiom.eval_results
(
    timestamp       DateTime64(3, 'UTC'),
    run_id          String,
    tenant_id       LowCardinality(String),
    dataset_name    LowCardinality(String),
    dataset_version UInt32,
    prompt_name     LowCardinality(String),
    prompt_version  LowCardinality(String),
    model           LowCardinality(String),
    case_id         String,
    metric          LowCardinality(String),
    score           Float64,
    passed          UInt8,
    detail          String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (run_id, timestamp)
TTL toDateTime(timestamp) + INTERVAL 13 MONTH
SETTINGS index_granularity = 8192;
