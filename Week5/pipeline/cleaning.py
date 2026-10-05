"""The ONE cleaning function, applied identically to real and forged text.

Raw format (see outputs/phase1_inspection.md): the rendered prose of a
Wikipedia article. Sections are separated by three or more newlines and the
first line of every section after the lead is its heading; paragraphs inside
a section are separated by single newlines; a blank line after a heading
usually precedes a flattened bullet list. Heading levels are not recoverable.

Cleaned format:
    paragraph            (lead, no heading)
    <blank>
    == Heading ==
    <blank>
    paragraph
    <blank>
    paragraph
"""
from __future__ import annotations

import re
import unicodedata

# Sections that hold references, link lists or tables rather than prose.
DROP_SECTIONS = {
    "references", "external links", "see also", "notes", "footnotes",
    "citations", "bibliography", "sources", "further reading", "works cited",
    "notes and references", "collected editions", "collected works",
    "writers", "pencilers", "pencillers", "inkers", "artists", "cover art",
    "colorists", "letterers", "volumes",
}

_QUOTE_MAP = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"',
    " ": " ", " ": " ", " ": " ", "​": "",
}
HEADING_RE = re.compile(r"^== (.+) ==$")


def _normalize_chars(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    for src, dst in _QUOTE_MAP.items():
        text = text.replace(src, dst)
    return text


def _is_heading_line(line: str) -> bool:
    return bool(HEADING_RE.match(line))


def clean_article(text: str) -> str:
    """Keep the prose, drop reference/link/table sections, unify headings.

    Works on raw Wikipedia text and on a forgery that already uses the
    `== Heading ==` form (a heading line is recognised either way).
    """
    text = _normalize_chars(text.replace("\r\n", "\n"))
    # A forgery written in the cleaned format marks headings explicitly; turn
    # them back into raw-style blocks so both inputs follow one code path.
    text = re.sub(r"(?m)^== (.+) ==$", r"\n\n\n\1", text)

    blocks = re.split(r"\n{3,}", text.strip())
    out: list[str] = []
    for i, block in enumerate(blocks):
        lines = [re.sub(r"\s+", " ", ln).strip() for ln in block.split("\n")]
        lines = [ln for ln in lines if ln]
        if not lines:
            continue
        if i == 0:
            heading, body = None, lines
        else:
            heading, body = lines[0], lines[1:]
            if heading.lower().strip(' "') in DROP_SECTIONS:
                continue                      # whole section is non-prose
        # table/list remnants: ISBN rows and fragments shorter than 3 words
        body = [ln for ln in body if "ISBN" not in ln and len(ln.split()) >= 3]
        if heading is not None and not body:
            continue                          # empty section (parent heading or stub)
        if heading is not None:
            out.append(f"== {heading} ==")
        out.extend(body)
    return "\n\n".join(out)


def prose_words(clean_text: str) -> list[str]:
    """Whitespace tokens of the cleaned text, heading markers removed."""
    words: list[str] = []
    for line in clean_text.split("\n"):
        m = HEADING_RE.match(line)
        words.extend((m.group(1) if m else line).split())
    return words


def word_count(clean_text: str) -> int:
    return len(prose_words(clean_text))


def truncate_words(clean_text: str, max_words: int) -> str:
    """First <= max_words words, cut at a paragraph boundary, no dangling heading."""
    kept: list[str] = []
    total = 0
    for para in clean_text.split("\n\n"):
        n = len(prose_words(para))
        if total + n > max_words:
            break
        kept.append(para)
        total += n
    while kept and _is_heading_line(kept[-1]):
        kept.pop()
    return "\n\n".join(kept)
