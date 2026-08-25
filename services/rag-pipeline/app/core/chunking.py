"""Chunking strategies (R1).

All strategies operate on plain text and return chunks with source spans so
citations can point back into the original document. Property invariants
enforced by tests:

  - coverage: concatenating chunk text recovers the source (no loss beyond
    stripped whitespace at boundaries)
  - bounds: every chunk respects max_chunk_chars (except single oversized
    sentences, which are hard-split)
  - overlap: consecutive recursive/fixed chunks share at most overlap chars
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")


@dataclass(frozen=True)
class Chunk:
    text: str
    start_offset: int
    end_offset: int
    ordinal: int


def _clip_tail(text: str, max_len: int) -> tuple[str, bool]:
    """Splits an oversized unit at a word boundary; returns (head, has_rest)."""
    if len(text) <= max_len:
        return text, False
    cut = text.rfind(" ", 0, max_len)
    if cut <= 0:
        cut = max_len
    return text[:cut], True


def chunk_fixed(
    text: str,
    max_chunk_chars: int = 1_000,
    overlap_chars: int = 150,
) -> list[Chunk]:
    """Fixed-size windows with character overlap."""
    if not text.strip():
        return []
    step = max(1, max_chunk_chars - overlap_chars)
    chunks: list[Chunk] = []
    offset = 0
    ordinal = 0
    while offset < len(text):
        piece = text[offset : offset + max_chunk_chars]
        if piece.strip():
            chunks.append(
                Chunk(
                    text=piece,
                    start_offset=offset,
                    end_offset=offset + len(piece),
                    ordinal=ordinal,
                )
            )
            ordinal += 1
        if offset + max_chunk_chars >= len(text):
            break
        offset += step
    return chunks


def _split_sentences(paragraph: str) -> list[str]:
    parts = [p.strip() for p in _SENTENCE_END.split(paragraph) if p.strip()]
    return parts or ([paragraph.strip()] if paragraph.strip() else [])


def chunk_recursive(
    text: str,
    max_chunk_chars: int = 1_000,
    overlap_sentences: int = 1,
) -> list[Chunk]:
    """Paragraph → sentence packing with sentence-level overlap.

    Respects natural boundaries first; falls back to hard word-boundary
    splits only for single sentences longer than max_chunk_chars.
    """
    if not text.strip():
        return []

    paragraphs = [p for p in text.split("\n\n") if p.strip()]
    units: list[tuple[str, int, int]] = []
    scanner = 0
    for paragraph in paragraphs:
        start = text.find(paragraph, scanner)
        scanner = start + len(paragraph)
        for sentence in _split_sentences(paragraph):
            s_start = text.find(sentence, start)
            units.append((sentence, s_start, s_start + len(sentence)))

    chunks: list[Chunk] = []
    current: list[tuple[str, int, int]] = []
    current_len = 0
    ordinal = 0

    def flush() -> None:
        nonlocal current, current_len, ordinal
        if not current:
            return
        body = " ".join(u[0] for u in current)
        chunks.append(
            Chunk(
                text=body,
                start_offset=current[0][1],
                end_offset=current[-1][2],
                ordinal=ordinal,
            )
        )
        ordinal += 1
        tail = current[-overlap_sentences:] if overlap_sentences > 0 else []
        current = list(tail)
        current_len = sum(len(u[0]) + 1 for u in current)

    for sentence, s_start, s_end in units:
        if len(sentence) > max_chunk_chars:
            flush()
            head, _ = _clip_tail(sentence, max_chunk_chars)
            chunks.append(
                Chunk(
                    text=head,
                    start_offset=s_start,
                    end_offset=s_start + len(head),
                    ordinal=ordinal,
                )
            )
            ordinal += 1
            rest = sentence[len(head) :].lstrip()
            while rest:
                head, has_rest = _clip_tail(rest, max_chunk_chars)
                start = s_end - len(rest)
                end = start + len(head)
                chunks.append(Chunk(text=head, start_offset=start, end_offset=end, ordinal=ordinal))
                ordinal += 1
                rest = rest[len(head) :].lstrip()
            continue

        if current_len + len(sentence) + 1 > max_chunk_chars and current:
            flush()
        current.append((sentence, s_start, s_end))
        current_len += len(sentence) + 1
    flush()
    return chunks


def chunk_markdown(
    text: str,
    max_chunk_chars: int = 1_000,
    overlap_sentences: int = 1,
) -> list[Chunk]:
    """Heading-aware splitting: sections never mix headings; each section is
    recursively chunked with its heading path prepended as metadata context."""
    lines = text.split("\n")
    sections: list[tuple[str, int]] = []  # (section_text, start_offset)
    buffer: list[str] = []
    section_start = 0
    scanner = 0
    for line in lines:
        line_start = text.find(line, scanner)
        scanner = line_start + len(line)
        if _HEADING.match(line) and buffer:
            sections.append(("\n".join(buffer), section_start))
            buffer = []
            section_start = line_start
        buffer.append(line)
    if buffer:
        sections.append(("\n".join(buffer), section_start))

    chunks: list[Chunk] = []
    ordinal = 0
    for section_text, base in sections:
        heading_match = _HEADING.match(section_text.split("\n", 1)[0])
        prefix = f"{heading_match.group(2)}\n" if heading_match else ""
        budget = max(64, max_chunk_chars - len(prefix))
        for part in chunk_recursive(
            section_text,
            max_chunk_chars=budget,
            overlap_sentences=overlap_sentences,
        ):
            chunks.append(
                Chunk(
                    text=f"{prefix}{part.text}",
                    start_offset=base + part.start_offset,
                    end_offset=base + part.end_offset,
                    ordinal=ordinal,
                )
            )
            ordinal += 1
    return chunks


STRATEGIES = {
    "fixed": chunk_fixed,
    "recursive": chunk_recursive,
    "sentence_window": chunk_recursive,  # window ≈ recursive with overlap
    "markdown": chunk_markdown,
    "layout": chunk_recursive,  # PDF layout-aware refinement lands with Unstructured extra
}


def chunk_text(
    text: str,
    strategy: str = "recursive",
    max_chunk_tokens: int = 512,
    overlap_tokens: int = 64,
) -> list[Chunk]:
    """Public entrypoint mapping token-ish parameters onto char budgets
    (~4 chars per token heuristic)."""
    fn = STRATEGIES.get(strategy)
    if fn is None:
        raise ValueError(f"unknown chunking strategy '{strategy}'")
    max_chunk_chars = max(200, max_chunk_tokens * 4)
    overlap_chars = max(0, min(overlap_tokens * 4, max_chunk_chars // 3))
    if strategy == "fixed":
        return chunk_fixed(text, max_chunk_chars=max_chunk_chars, overlap_chars=overlap_chars)
    if strategy == "markdown":
        return chunk_markdown(text, max_chunk_chars=max_chunk_chars, overlap_sentences=1)
    return chunk_recursive(text, max_chunk_chars=max_chunk_chars, overlap_sentences=1)
