"""Guardrails engine for RAG knowledge pipeline (X5, Milestone 5.1).

Provides Presidio-style PII detection and redaction for ingested documents
prior to chunking and vectorstore indexing.
"""

from __future__ import annotations

import re

from app.core.metrics import axiom_guardrail_pii_redactions_total


def luhn_check(card_number: str) -> bool:
    clean = re.sub(r"\D", "", card_number)
    if not (13 <= len(clean) <= 19):
        return False
    total = 0
    should_double = False
    for char in reversed(clean):
        digit = int(char)
        if should_double:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
        should_double = not should_double
    return total % 10 == 0


EMAIL_REGEX = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
SSN_REGEX = re.compile(r"\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b")
CREDIT_CARD_REGEX = re.compile(r"\b(?:\d{4}[ -]?){3}\d{4}\b|\b\d{15,16}\b")
PHONE_REGEX = re.compile(
    r"(?:^|(?<=[^\w]))(?:\+?1[-. ]?)?\(?([0-9]{3})\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})(?=[^\w]|$)"
)
IP_REGEX = re.compile(
    r"\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b"
)
API_KEY_REGEX = re.compile(
    r"\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9_\-.]{25,})\b"
)


def _validate_ssn(match_str: str) -> bool:
    clean = re.sub(r"\D", "", match_str)
    if len(clean) != 9:
        return False
    if clean == "000000000" or clean.startswith("000") or clean.startswith("666"):
        return False
    return True


def redact_pii(text: str, tenant_id: str = "unknown") -> tuple[str, list[str]]:
    """Sanitizes PII in text and returns (sanitized_text, detected_entity_types)."""
    current = text
    found_entities: set[str] = set()

    # 1. API Keys
    if API_KEY_REGEX.search(current):
        current = API_KEY_REGEX.sub("[REDACTED_API_KEY]", current)
        found_entities.add("API_KEY")

    # 2. Emails
    if EMAIL_REGEX.search(current):
        current = EMAIL_REGEX.sub("[REDACTED_EMAIL]", current)
        found_entities.add("EMAIL_ADDRESS")

    # 3. SSNs
    def _replace_ssn(m: re.Match[str]) -> str:
        s = m.group(0)
        if _validate_ssn(s):
            found_entities.add("US_SSN")
            return "[REDACTED_SSN]"
        return s

    current = SSN_REGEX.sub(_replace_ssn, current)

    # 4. Credit Cards
    def _replace_cc(m: re.Match[str]) -> str:
        s = m.group(0)
        if luhn_check(s):
            found_entities.add("CREDIT_CARD")
            return "[REDACTED_CREDIT_CARD]"
        return s

    current = CREDIT_CARD_REGEX.sub(_replace_cc, current)

    # 5. Phone numbers
    if PHONE_REGEX.search(current):
        current = PHONE_REGEX.sub("[REDACTED_PHONE]", current)
        found_entities.add("PHONE_NUMBER")

    # 6. IPs
    if IP_REGEX.search(current):
        current = IP_REGEX.sub("[REDACTED_IP]", current)
        found_entities.add("IP_ADDRESS")

    if found_entities:
        for ent in found_entities:
            axiom_guardrail_pii_redactions_total.inc({
                "job": "rag-pipeline",
                "type": ent,
                "tenant_id": tenant_id,
            })

    return current, sorted(found_entities)
