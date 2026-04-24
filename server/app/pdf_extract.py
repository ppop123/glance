"""Extract readable paragraphs from a PDF. Tuned for academic papers:
multi-column aware via pdfminer's LAParams, paragraph boundaries inferred
from vertical gaps + sentence terminators.

Returns a flat list of (page_index, paragraph_text). Figures, equations,
and headers/footers are best-effort filtered by short-line + repeat-line
heuristics."""
from __future__ import annotations

import io
import re
from dataclasses import dataclass
from typing import Iterator

from pdfminer.high_level import extract_pages
from pdfminer.layout import LAParams, LTTextBox, LTTextLine


MIN_PARA_CHARS = 20          # drop figure captions / page numbers
MAX_PAGES_HARD_CAP = 60      # refuse PDFs bigger than this — cost-guard
HEADER_FOOTER_VERT_PCT = 0.07   # top/bottom 7% of page = probably chrome


@dataclass
class Paragraph:
    page: int     # 1-indexed
    text: str


def extract_paragraphs(pdf_bytes: bytes) -> list[Paragraph]:
    """Parse a PDF byte blob and return clean paragraphs in reading order.

    The LAParams here are tuned for typical 2-column academic layout:
        - `word_margin` loose so glyphs that are drawn with kerning still join
        - `line_margin` tight so paragraph breaks land in the right place
        - `boxes_flow` set to detect column order correctly
    """
    laparams = LAParams(
        word_margin=0.1,
        line_margin=0.5,
        char_margin=2.0,
        boxes_flow=0.5,
        detect_vertical=False,
    )
    out: list[Paragraph] = []
    fp = io.BytesIO(pdf_bytes)
    pages = list(extract_pages(fp, laparams=laparams, maxpages=MAX_PAGES_HARD_CAP))
    if not pages:
        return out

    # First pass: collect all lines with their y position per page to detect
    # running headers / footers (text that repeats on many pages near the
    # top/bottom edge — page numbers, journal names, etc.).
    running_lines: dict[str, int] = {}
    for page in pages:
        page_h = page.height
        top_zone = page_h * (1 - HEADER_FOOTER_VERT_PCT)
        bot_zone = page_h * HEADER_FOOTER_VERT_PCT
        for box in page:
            if not isinstance(box, LTTextBox):
                continue
            for line in box:
                if not isinstance(line, LTTextLine):
                    continue
                txt = _normalize(line.get_text())
                if not txt or len(txt) > 80:
                    continue
                # Lines in header/footer bands
                y0, y1 = line.y0, line.y1
                if y0 > top_zone or y1 < bot_zone:
                    running_lines[txt] = running_lines.get(txt, 0) + 1
    # "Repeats on 40%+ of pages" → treat as chrome
    junk_lines = {t for t, c in running_lines.items()
                  if c >= max(2, len(pages) * 0.4)}

    # Second pass: emit paragraphs. A pdfminer LTTextBox roughly corresponds
    # to a visual block; treat each as one paragraph unless it crosses a
    # sentence boundary WITH a blank-line gap (rare for well-authored PDFs).
    for page_idx, page in enumerate(pages, start=1):
        for box in page:
            if not isinstance(box, LTTextBox):
                continue
            raw = box.get_text()
            if not raw:
                continue
            # Hyphen-at-EOL handling. Order matters — do this BEFORE the soft
            # line-break join below, otherwise `-\n` becomes `- ` and we lose
            # the signal to distinguish these two cases:
            #
            # (1) Word broken mid-syllable by justified-text wrapping:
            #     "lang-\nuage" → "language" (hyphen IS a typographic artifact)
            # (2) Compound proper noun with an intentional hyphen:
            #     "Mixture-of-\nExperts" → "Mixture-of-Experts" (hyphen stays)
            #
            # Distinguishing heuristic: in (1) both sides are lowercase, in (2)
            # the right side starts with an uppercase letter (or digit, as in
            # "DeepSeek-V4-\nPro" where it's already an alphabetic class).
            raw = re.sub(r"([a-z])-\n([a-z])", r"\1\2", raw)      # (1) join
            raw = re.sub(r"-\n", "-", raw)                        # (2) strip \n, keep -
            # Join the rest of the soft line breaks inside a paragraph. The
            # `.!?` lookbehind preserves sentence terminators so the paragraph
            # splitter below still fires at real paragraph boundaries.
            raw = re.sub(r"(?<![.!?])\n(?!\n)", " ", raw)
            # Tidy up any doubled spaces left by the joins.
            raw = re.sub(r"  +", " ", raw)
            # Split on blank lines — pdfminer uses them to delimit paragraph runs
            for chunk in raw.split("\n"):
                t = _normalize(chunk)
                if not t or len(t) < MIN_PARA_CHARS:
                    continue
                if t in junk_lines:
                    continue
                # Skip obvious standalone refs-block / citation dump paragraphs?
                # For now keep them — the LLM handles them fine.
                out.append(Paragraph(page=page_idx, text=t))
    return out


def _normalize(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()


def chunks_of(paras: list[Paragraph], size: int) -> Iterator[list[Paragraph]]:
    """Split paragraphs into chunks suitable for one batch translation call."""
    for i in range(0, len(paras), size):
        yield paras[i:i + size]


# ── Page rasterization ────────────────────────────────────────────────
# pdfminer.six gives us the text; it does NOT give us the figures,
# equations-as-images, or tables. For academic papers those are often the
# most information-dense parts of the page. Rasterize each page and embed
# the image so the user sees the original layout alongside the translation.

def render_page_pngs(pdf_bytes: bytes, *, max_pages: int, dpi: int = 110) -> list[bytes]:
    """Return one PNG (bytes) per page, up to `max_pages`. Default DPI of 110
    strikes a balance: readable formulas at 100% zoom without bloating the
    HTML. A letter-page PNG at 110 DPI is typically 60-180 KB."""
    import pypdfium2 as pdfium
    out: list[bytes] = []
    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        n = min(len(pdf), max_pages)
        scale = dpi / 72.0  # pdfium scale is relative to 72 DPI
        for i in range(n):
            page = pdf[i]
            try:
                pil = page.render(scale=scale).to_pil()
                import io
                buf = io.BytesIO()
                pil.save(buf, format="PNG", optimize=True)
                out.append(buf.getvalue())
            finally:
                page.close()
    finally:
        pdf.close()
    return out
