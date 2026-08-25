"""Property-style tests for chunking (R1) and parser registry (R1)."""

import random

import pytest

from app.core.chunking import chunk_fixed, chunk_markdown, chunk_recursive, chunk_text
from app.core.parsers import parse_document, parse_html


def _words(n: int, seed: int) -> str:
    rng = random.Random(seed)
    return " ".join(f"w{rng.randrange(10_000)}" for _ in range(n))


class TestChunkProperties:
    def test_no_data_loss_recursive(self) -> None:
        text = " ".join(_words(400, seed=1))
        chunks = chunk_recursive(text, max_chunk_chars=300, overlap_sentences=0)
        joined = " ".join(chunk.text for chunk in chunks)
        assert set(text.split()) <= set(joined.split())

    def test_all_chunks_within_bounds(self) -> None:
        text = "\n\n".join(_words(120, seed=s) for s in range(20))
        chunks = chunk_recursive(text, max_chunk_chars=500, overlap_sentences=1)
        assert chunks
        for chunk in chunks:
            assert len(chunk.text) <= 500 * 1.35  # overlap headroom

    def test_overlap_does_not_exceed_chunk_size(self) -> None:
        text = _words(200, seed=2)
        chunks = chunk_fixed(text, max_chunk_chars=200, overlap_chars=50)
        for previous, current in zip(chunks, chunks[1:], strict=False):
            shared = set(previous.text.split()) & set(current.text.split())
            assert len(shared) <= 50

    def test_randomized_never_crashes_and_covers(self) -> None:
        rng = random.Random(42)
        for trial in range(30):
            size = rng.randrange(50, 5_000)
            text = _words(size, seed=trial)
            strategy = rng.choice(["fixed", "recursive", "markdown"])
            chunks = chunk_text(
                text,
                strategy=strategy,
                max_chunk_tokens=rng.randrange(64, 512),
                overlap_tokens=rng.randrange(0, 64),
            )
            if text.strip():
                assert chunks, f"{strategy} produced no chunks for {size} words"
                joined = " ".join(c.text.lower() for c in chunks)
                assert all(word in joined for word in text.lower().split()[:20])

    def test_empty_input_yields_no_chunks(self) -> None:
        assert chunk_recursive("   ") == []
        assert chunk_fixed("") == []

    def test_unknown_strategy_raises(self) -> None:
        with pytest.raises(ValueError, match="unknown chunking strategy"):
            chunk_text("hello", strategy="quantum")


class TestMarkdownAwareness:
    def test_sections_do_not_merge_across_top_level_headings(self) -> None:
        doc = (
            "# Alpha\n\nalpha body sentence one.\n\n"
            "# Beta\n\nbeta body sentence two.\n\n"
            "# Gamma\n\ngamma body sentence three."
        )
        chunks = chunk_markdown(doc, max_chunk_chars=10_000)
        texts = [chunk.text for chunk in chunks]
        assert any(t.startswith("Alpha") for t in texts)
        assert any(t.startswith("Beta") for t in texts)
        # A chunk starting with Alpha must not contain Gamma content.
        alpha = next(t for t in texts if t.startswith("Alpha"))
        assert "Gamma" not in alpha


class TestParsers:
    def test_plain_text(self) -> None:
        parsed = parse_document("text/plain", b"just some text")
        assert parsed.parser == "text"
        assert parsed.text == "just some text"

    def test_html_strips_scripts_and_tags(self) -> None:
        html = (
            b"<html><head><style>body{color:red}</style></head>"
            b"<body><h1>Title</h1><script>alert(1)</script>"
            b"<p>Paragraph &amp; entities</p></body></html>"
        )
        parsed = parse_document("text/html", html)
        assert "Title" in parsed.text
        assert "Paragraph & entities" in parsed.text
        assert "alert(1)" not in parsed.text
        assert "color:red" not in parsed.text

    def test_unknown_binary_rejected(self) -> None:
        import pytest

        with pytest.raises(ValueError, match="unsupported content_type"):
            parse_document("application/x-msdownload", b"MZ...")

    def test_pdf_roundtrip(self) -> None:
        """Generates a tiny PDF with pypdf's writer, then parses it back."""
        import io

        import pypdf

        writer = pypdf.PdfWriter()
        page = pypdf.PageObject.create_blank_page(width=612, height=792)
        writer.add_page(page)
        buffer = io.BytesIO()
        writer.write(buffer)

        parsed = parse_document("application/pdf", buffer.getvalue())
        assert parsed.parser == "pypdf"
        assert parsed.page_count == 1

    def test_parse_html_helper_direct(self) -> None:
        parsed = parse_html(b"<p>hello</p>")
        assert "hello" in parsed.text
