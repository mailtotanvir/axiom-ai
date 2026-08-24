# 1. Record architecture decisions

Date: 2026-08-24
Status: Accepted

## Context

Axiom AI is a multi-service platform where choices about languages, infrastructure, and delivery mechanics must outlive individual contributors and remain auditable as the project open-sources.

## Decision

Adopt Architecture Decision Records as defined by Michael Nygard ([documenting architecture decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)). Every material architectural choice gets a numbered ADR in this folder (`NNNN-slug.md`), is immutable once accepted (superseded by a new ADR instead of edited), and is linked from pull requests that implement it.

## Format

Each ADR contains: Title, Date, Status (Proposed/Accepted/Superseeded), Context, Decision, Consequences.
