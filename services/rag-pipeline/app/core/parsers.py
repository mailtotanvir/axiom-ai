"""Parser registry (R1): converts raw document bytes into plain text.

Builtin parsers cover text/markdown/html/pdf with zero heavyweight
dependencies. When the optional `unstructured` extra is installed
(`pip install -r requirements-unstructured.txt`) it takes precedence for
pdf/docx/complex formats per the architecture spec; otherwise the builtin
PDF path (pypdf) handles pdf and unknown binaries fail with a clear error.
"""

from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser

try:
    import pypdf

    _HAS_PYPDF = True
except ImportError:  # pragma: no cover - exercised only without pypdf
    _HAS_PYPDF = False


@dataclass(frozen=True)
class ParsedDocument:
    text: str
    parser: str
    page_count: int = 1


class _TextExtractor(HTMLParser):
    _SKIP = {"script", "style"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._SKIP:
            self._skip_depth += 1
        if tag in ("p", "br", "div", "li", "h1", "h2", "h3", "h4", "tr"):
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0 and data.strip():
            self.parts.append(data)


def parse_html(raw: bytes) -> ParsedDocument:
    extractor = _TextExtractor()
    extractor.feed(raw.decode("utf-8", errors="replace"))
    return ParsedDocument(text="\n".join(extractor.parts), parser="html")


def parse_text(raw: bytes) -> ParsedDocument:
    return ParsedDocument(text=raw.decode("utf-8", errors="replace"), parser="text")


def parse_pdf(raw: bytes) -> ParsedDocument:
    try:
        return _parse_pdf_unstructured(raw)
    except ImportError:
        return _parse_pdf_pypdf(raw)


def _parse_pdf_unstructured(raw: bytes) -> ParsedDocument:
    import os
    import tempfile  # local import keeps optional dep lazy

    from unstructured.partition.pdf import partition_pdf  # type: ignore[import-not-found]

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as handle:
        handle.write(raw)
        path = handle.name
    try:
        elements = partition_pdf(path)
        text = "\n\n".join(str(element) for element in elements)
        pages = sum(1 for e in elements if getattr(e, "category", "") == "PageBreak") + 1
        return ParsedDocument(text=text, parser="unstructured-pdf", page_count=pages)
    finally:
        os.unlink(path)


def _parse_pdf_pypdf(raw: bytes) -> ParsedDocument:
    if not _HAS_PYPDF:
        raise RuntimeError(
            "no PDF parser available: install pypdf or requirements-unstructured.txt"
        )
    import io

    reader = pypdf.PdfReader(io.BytesIO(raw))
    pages = [page.extract_text() or "" for page in reader.pages]
    return ParsedDocument(
        text="\n\n".join(pages),
        parser="pypdf",
        page_count=len(reader.pages),
    )


PARSERS = {
    "text/plain": parse_text,
    "text/markdown": parse_text,
    "text/html": parse_html,
    "application/pdf": parse_pdf,
}


def parse_document(content_type: str, raw: bytes) -> ParsedDocument:
    """Parses by content type. Unknown binary types are rejected rather
    than silently garbled (fail closed)."""
    handler = PARSERS.get(content_type)
    if handler is None:
        if content_type.startswith("text/"):
            return parse_text(raw)
        raise ValueError(f"unsupported content_type '{content_type}'")
    return handler(raw)
