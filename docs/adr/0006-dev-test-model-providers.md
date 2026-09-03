# 6. Development/test model providers

Date: 2026-08-24
Status: Accepted

## Context

CI and local development need real LLM calls without paid OpenAI/Anthropic accounts. The environment provides keys for Gemini (`gemini-3.6-flash`), Groq, Mistral, SiliconFlow, and NVIDIA NIM.

## Decision

All provider adapters speak the OpenAI-compatible chat-completions wire format. The five provided providers are first-class dev/test targets; OpenAI and Anthropic adapters ship key-gated (inactive without credentials). Contract tests run against recorded fixtures per PR and live endpoints nightly.

## Consequences

Zero spend in CI. Provider drift is contained inside adapters; capability metadata (context window, cost) lives centrally in `@tanvir1971/core`.
