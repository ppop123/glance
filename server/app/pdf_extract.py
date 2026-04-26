"""Extract readable paragraphs from a PDF. Tuned for academic papers.

Backend: PyMuPDF (fitz). We previously used pdfminer.six but its layout
analyzer mangled math-prose paragraphs — equations rendered across
multiple lines would get spliced INTO the surrounding sentence in the
wrong order, producing un-translatable "by a factor of 𝑛 hc ×𝑑 be the
where 𝑑 is the hidden size..." soup. PyMuPDF uses the same MuPDF layout
engine that Chromium / Safari preview uses, and reads the source
paragraph in its natural left-to-right, top-to-bottom flow even when math
spans multiple visual lines.

Returns a flat list of Paragraph(page, text, bbox, page_height). Figures,
equations, and headers/footers are best-effort filtered by short-line +
repeat-line heuristics — the same downstream consumers
(detect_figure_crops / detect_noise_paragraphs) work unchanged."""
from __future__ import annotations

import re
from dataclasses import dataclass

import fitz  # PyMuPDF


MIN_PARA_CHARS = 20          # drop figure captions / page numbers
MAX_PAGES_HARD_CAP = 60      # refuse PDFs bigger than this — cost-guard
HEADER_FOOTER_VERT_PCT = 0.07   # top/bottom 7% of page = probably chrome


@dataclass
class Paragraph:
    page: int     # 1-indexed
    text: str
    # PDF-space bbox of the originating block (origin = bottom-left,
    # y increases upward). fitz natively uses top-down coords; we flip them
    # at construction time so detect_figure_crops can keep its bottom-up
    # convention. None if a fragment has no surviving bbox info.
    bbox: tuple[float, float, float, float] | None = None
    page_height: float | None = None


def extract_paragraphs(pdf_bytes: bytes) -> list[Paragraph]:
    """Parse a PDF byte blob and return clean paragraphs in reading order.

    fitz's ``page.get_text("blocks")`` returns one block per visual paragraph
    in the source PDF — much closer to the actual reading order than
    pdfminer's column-then-flow heuristic. Each block is already the right
    granularity for translation; we only do per-block hyphenation cleanup
    + the same junk-line / paragraph-split passes as the old extractor."""
    out: list[Paragraph] = []
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        n = min(len(doc), MAX_PAGES_HARD_CAP)
        if n == 0:
            return out

        # First pass: collect lines with their y position per page to detect
        # running headers / footers (text that repeats on many pages near the
        # top/bottom edge — page numbers, journal names, etc.).
        running_lines: dict[str, int] = {}
        for i in range(n):
            page = doc[i]
            ph = page.rect.height
            top_zone = ph * (1 - HEADER_FOOTER_VERT_PCT)
            bot_zone = ph * HEADER_FOOTER_VERT_PCT
            for block in page.get_text("blocks"):
                x0, y0, x1, y1, btext, _bno, btype = block
                if btype != 0:           # 0 = text, 1 = image
                    continue
                # fitz y-axis is top-down; "below the top zone" means y0 < top_zone
                # but we want "in the top chrome band" = y1 < top_zone (whole block
                # sits in top 7%) OR "in the bottom chrome band" = y0 > bot_zone.
                # Equivalent in top-down coords: y1 < ph*0.07 (top band) or
                # y0 > ph*0.93 (bottom band).
                in_top_band = y1 < ph * HEADER_FOOTER_VERT_PCT
                in_bot_band = y0 > ph * (1 - HEADER_FOOTER_VERT_PCT)
                if not (in_top_band or in_bot_band):
                    continue
                for line in btext.strip().splitlines():
                    s = _normalize(line)
                    if not s or len(s) > 80:
                        continue
                    running_lines[s] = running_lines.get(s, 0) + 1
        junk_lines = {t for t, c in running_lines.items()
                      if c >= max(2, n * 0.4)}

        # Second pass: emit paragraphs. fitz blocks already correspond to
        # visual paragraphs; we just normalize per-block.
        for i in range(n):
            page = doc[i]
            ph = page.rect.height
            for block in page.get_text("blocks"):
                x0, y0, x1, y1, raw, _bno, btype = block
                if btype != 0 or not raw:
                    continue
                # Convert top-down y to bottom-up PDF-space y so downstream
                # detect_figure_crops can keep its existing convention.
                pdf_y0 = ph - y1   # bottom edge in PDF coords
                pdf_y1 = ph - y0   # top edge in PDF coords
                box_bbox = (x0, pdf_y0, x1, pdf_y1)

                # Hyphen-at-EOL handling. Order matters — do this BEFORE the
                # soft line-break join below, otherwise `-\n` becomes `- ` and
                # we lose the signal to distinguish these two cases:
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
                # Join ALL single line breaks inside a paragraph — including
                # those that follow a sentence terminator. Soft line wraps
                # within fitz's blocks are common; only blank lines (\n\n+)
                # signal a real paragraph boundary.
                raw = re.sub(r"(?<!\n)\n(?!\n)", " ", raw)
                raw = re.sub(r"  +", " ", raw)

                for chunk in re.split(r"\n\s*\n+", raw):
                    t = _normalize(chunk)
                    if not t or len(t) < MIN_PARA_CHARS:
                        continue
                    if t in junk_lines:
                        continue
                    out.append(Paragraph(
                        page=i + 1, text=t,
                        bbox=box_bbox, page_height=ph,
                    ))
    finally:
        doc.close()

    # Post-pass: merge fragment paragraphs that look like a single
    # mathematical expression split across blocks. fitz fragments far less
    # than pdfminer did, but the merger is still useful for the rare cases
    # where a numbered equation lands in its own block right next to its
    # introducing sentence.
    return _merge_continuation_fragments(out)


# Lines starting with these chars are almost always continuations of a
# preceding expression or list, not the start of a fresh thought. Math
# operators, closing brackets, conjunctions in lowercase — never the start
# of a new sentence in well-edited prose.
_MATH_CONTINUATION = re.compile(r"^[\s]*[)\]}+,;=·×→←↔≈≤≥<>·•∈∉⊂⊆∩∪]")
# Lines ending without one of these terminators MIGHT be continuations.
_TERMINATOR_RE = re.compile(r"[.!?。！？:：]\s*[\"”')\]]?\s*$")
# Caption / heading prefixes — these are NEW units, never continuations.
_NEW_UNIT_PREFIX = re.compile(
    r"^(?:Figure|Fig\.|Table|Algorithm|Equation|Eq\.|Lemma|Theorem|Corollary|Proposition|Definition|Remark|"
    r"\d+(?:\.\d+)*\s+[A-Z]|"  # "3.1 Introduction"
    r"图\s*\d|表\s*\d|算法\s*\d|定理|引理|推论|命题|定义|备注)"
)


def _merge_continuation_fragments(paras: list[Paragraph]) -> list[Paragraph]:
    """Stitch back fragments that pdfminer separated into different LTTextBoxes
    but that visually + semantically belong together: equations split across
    boxes, prose mid-sentence carrying onto the next box, bullets interrupted
    by an inline figure caption, etc.

    Strategy: keep an index pointer to the last "ordinary prose" paragraph
    we appended. When we see a paragraph whose first non-whitespace char is
    LOWERCASE (almost never starts a fresh sentence) or a math operator /
    closing bracket, merge it into THAT pointer rather than the immediate
    previous paragraph — so a Figure caption sandwiched between two halves
    of a bullet doesn't split the bullet.

    Section headings / figure / table captions match `_NEW_UNIT_PREFIX` and
    are appended unchanged; they don't update the prose pointer. Anything
    else updates the pointer."""
    if not paras:
        return paras
    merged: list[Paragraph] = []
    last_prose_idx = -1
    for p in paras:
        if _NEW_UNIT_PREFIX.match(p.text):
            # Headings / captions never absorb continuations and never act
            # as "prose targets". Just append.
            merged.append(p)
            continue
        first_real = p.text.lstrip()[:1]
        is_math_cont = bool(_MATH_CONTINUATION.match(p.text))
        is_lowercase_cont = bool(first_real) and first_real.islower() and first_real.isascii()
        if last_prose_idx >= 0 and (is_math_cont or is_lowercase_cont):
            target = merged[last_prose_idx]
            merged[last_prose_idx] = Paragraph(
                page=target.page, text=f"{target.text} {p.text}",
                # Keep the FIRST box's bbox — that's the one tied to where the
                # paragraph actually starts on the page, and it's what later
                # heuristics (figure-crop matching) anchor to.
                bbox=target.bbox, page_height=target.page_height,
            )
        else:
            merged.append(p)
            last_prose_idx = len(merged) - 1
    return merged


def _normalize(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()


def chunks_of(paras: list[Paragraph], size: int) -> Iterator[list[Paragraph]]:
    """Split paragraphs into chunks suitable for one batch translation call."""
    for i in range(0, len(paras), size):
        yield paras[i:i + size]


# Captions for figures or tables. We require a separator (`|`, `│`, `:`, `.`)
# after the number so we don't mis-classify body sentences like "Table 13
# presents the creative writing comparison..." as captions.
# Numbers can be multi-digit (Table 11, 12, ...) and may be sub-numbered
# ("Figure 2.3") in some venues, so allow `\d+(?:\.\d+)?`.
_FIGURE_CAPTION_RE = re.compile(
    r"^(?:Figure|Fig\.|Table|Tab\.|图|表)\s*\d+(?:\.\d+)?\s*[|│:.]",
    re.IGNORECASE,
)

# Subset matching ONLY tables. Used to flip the crop direction (look BELOW
# the caption, not above) since academic-paper convention is caption-above-
# table — the inverse of figures, where caption sits below the visual.
_TABLE_CAPTION_RE = re.compile(
    r"^(?:Table|Tab\.|表)\s*\d+(?:\.\d+)?\s*[|│:.]",
    re.IGNORECASE,
)


@dataclass
class FigureCrop:
    """A region of a PDF page that contains a figure / chart / table — the
    visual content above a `Figure N |` caption that pdfminer can't pull as
    text. Pixel coords are computed lazily by main.py once we know the
    page-image scale; this struct just carries PDF-space coordinates."""
    page: int                  # 1-indexed
    caption_text_prefix: str   # "Figure 3 |" — used to match caption to crop
    pdf_top: float             # PDF-space y of the figure's top edge (= bottom of nearest text-box above)
    pdf_bottom: float          # PDF-space y of the figure's bottom edge (= caption.y1)
    page_height: float


# ── Noise filters: paragraphs that aren't worth translating ──────────────
# Same theme as detect_figure_crops's drop set: pdfminer extracts everything
# the page draws as text, including layout artifacts that produce gibberish
# under translation. We surface a separate noise set so main.py can prune
# them BEFORE cache lookup / LLM batches.

# 5+ consecutive ". . . . ." dot-leader pairs — table-of-contents entries
# and the bare leader fragments pdfminer pulls as their own LTTextBox.
_TOC_DOT_LEADER_RE = re.compile(r"\.\s\.\s\.\s\.\s\.")

# pdfminer's notation for glyphs it couldn't map to a Unicode character —
# usually because the embedded font has no /ToUnicode CMap. They show up as
# "(cid:12) (cid:34) ..." sequences in the extracted text. They're untranslatable
# noise (the model just echoes them) and pollute the bilingual view, so we
# drop any paragraph that's mostly these markers.
_CID_RE = re.compile(r"\(cid:\d+\)")

# Math-italic Unicode block — used when LaTeX is rendered to PDF, the variable
# names come out as glyphs in this block (e.g., "𝐶𝑎 = 𝐻 · 𝑊 𝑎𝐾𝑉").
# Only paragraphs that are mostly these glyphs (no surrounding prose) are
# treated as pure-equation noise.
_MATH_ITALIC_LOW = "\U0001D400"
_MATH_ITALIC_HIGH = "\U0001D7FF"
_COMMON_MATH_OPS = set("+=−×÷·∗∇∈⊂≤≥≠≈→↔∑∏∫∂")


def _is_toc_paragraph(text: str) -> bool:
    """Detect TOC artifacts: pure dot-leaders, or section titles followed
    by a long dot leader. 5+ alternating ``. .`` pairs is the threshold —
    body prose effectively never hits this."""
    t = text.strip()
    if not t:
        return False
    stripped = re.sub(r"[\s\.]", "", t)
    # Pure dots (possibly with whitespace) — pdfminer extracts the leader
    # column of the TOC as its own LTTextBox.
    if not stripped and t.count(".") >= 5:
        return True
    if _TOC_DOT_LEADER_RE.search(t):
        return True
    return False


def _is_cid_noise(text: str) -> bool:
    """Detect paragraphs dominated by pdfminer's "(cid:N)" placeholders.

    A glyph that pdfminer couldn't map to Unicode comes out as the literal
    string "(cid:12)" etc. — translating these produces nonsense; the user
    can read the same content from the figure-crop image / original PDF if
    they need it. Drop when ≥ 30% of the paragraph's chars are inside cid
    markers, or when there are 3+ markers and barely any other content.
    """
    if "(cid:" not in text:
        return False
    matches = _CID_RE.findall(text)
    if not matches:
        return False
    cid_chars = sum(len(m) for m in matches)
    return (cid_chars / max(1, len(text)) >= 0.3) or (
        len(matches) >= 3 and len(text.strip()) - cid_chars < 20
    )


def _is_pure_equation(text: str) -> bool:
    """Standalone equation paragraph: very few ASCII letters + a meaningful
    chunk of math glyphs (math-italic block or common operators). Inline math
    inside prose is fine — only when the WHOLE paragraph is math do we drop
    it (translating "𝜋𝐸𝑖 ( 𝑦𝑡 | 𝑥,𝑦<𝑡 )" produces nonsense)."""
    t = text.strip()
    if len(t) < 5:
        return False
    non_ws = [c for c in t if not c.isspace()]
    if not non_ws:
        return False
    ascii_alpha = sum(1 for c in non_ws if c.isalpha() and ord(c) < 128)
    math_glyphs = sum(
        1 for c in non_ws
        if (_MATH_ITALIC_LOW <= c <= _MATH_ITALIC_HIGH) or (c in _COMMON_MATH_OPS)
    )
    # "Mostly math" — at least 6 math glyphs, ASCII letters under 30% of
    # non-whitespace chars.
    return math_glyphs >= 6 and ascii_alpha < len(non_ws) * 0.3


def detect_noise_paragraphs(paras: list[Paragraph]) -> set[int]:
    """Return indices into ``paras`` that are content-noise (TOC fragments,
    pure-equation paragraphs). Caller should drop them from the translation
    pipeline alongside ``detect_figure_crops``'s in-table cells.

    Two-pass:

      1. Per-paragraph: pure dot-leaders, pure-equation paragraphs.
      2. Per-page: if ≥ 40% of a page's paragraphs already match the TOC
         pattern (lots of "Section Title . . . ." entries), the whole page
         is a TOC — drop every paragraph on it. This catches TOC entries
         whose dot leaders ended up in a separate LTTextBox so the title
         column alone ("2.2 Manifold-Constrained Hyper-Connections") didn't
         trigger the per-paragraph rule.
    """
    drop: set[int] = set()

    # First pass.
    toc_per_page: dict[int, int] = {}
    total_per_page: dict[int, int] = {}
    for i, p in enumerate(paras):
        total_per_page[p.page] = total_per_page.get(p.page, 0) + 1
        if _is_toc_paragraph(p.text):
            drop.add(i)
            toc_per_page[p.page] = toc_per_page.get(p.page, 0) + 1
        elif _is_pure_equation(p.text) or _is_cid_noise(p.text):
            drop.add(i)

    # Second pass: TOC-page detection. Threshold tuned conservative — a real
    # content page should never have 40%+ paragraphs matching the dot-leader
    # pattern, so this only fires on actual TOC pages.
    toc_pages = {
        page for page, n_total in total_per_page.items()
        if n_total >= 5 and toc_per_page.get(page, 0) / n_total >= 0.4
    }
    if toc_pages:
        for i, p in enumerate(paras):
            if p.page in toc_pages:
                drop.add(i)

    return drop


def detect_figure_crops(paras: list[Paragraph]) -> tuple[list[FigureCrop], set[int]]:
    """Walk the extracted paragraphs and, for each Figure / Table caption,
    compute a crop region around the visual content the caption refers to.
    Returns ``(crops, drop_para_indices)``:

      - ``crops``: list[FigureCrop], one per caption (degenerate ones still
        emitted so callers can pair by index); ordered by caption discovery.
      - ``drop_para_indices``: set of indices into ``paras`` that fall inside
        a *table* region — i.e., they are cell text the caller should drop
        from translation. The table image already contains them visually;
        re-translating multi-column row fragments produces gibberish (cell
        shards interleaved with rotated header letters etc.).

    Direction depends on caption type:

      - **Figures** (and 图 N): caption sits *below* the figure → look UP.
        The crop is the empty space above the caption, bounded by the
        nearest text-box above (its bottom = the figure's top edge).

      - **Tables** (and 表 N): caption sits *above* the table → look DOWN.
        Walk through cells using a "y-coverage" rule that handles
        side-by-side columns (their LTTextBoxes overlap in y) and stops at
        the first big visual break (gap > walk_threshold) or any
        obviously-prose paragraph.

    PDF coords: origin = bottom-left, so "above" = larger y, "below" =
    smaller y, and ``box.y1 > box.y0``.
    """
    crops: list[FigureCrop] = []
    drop: set[int] = set()
    # Group paragraphs by page, carrying the original index so the drop set
    # can refer back to ``paras``.
    by_page: dict[int, list[tuple[int, Paragraph]]] = {}
    for i, p in enumerate(paras):
        if p.bbox is not None and p.page_height is not None:
            by_page.setdefault(p.page, []).append((i, p))

    # Heuristic constants. Tuned on multi-column tables in the DeepSeek-V4
    # paper (Tables 5, 6, 9 — narrow cells, overlapping columns, varied row
    # heights). If you change these, eyeball the rendered crops on a paper
    # with both wide and narrow tables before shipping.
    INITIAL_GAP_MAX = 80.0   # max gap from caption to first cell (for tables)
    # Width-based prose detection: a box wider than this fraction of the
    # widest box on the page is treated as a body paragraph, not a table
    # cell. Pdfminer often merges all cells in one COLUMN into a single
    # LTTextBox (139pt-tall column of numbers), so a height filter can't
    # distinguish "tall column of cells" from "tall prose block" — but
    # width can: cells/columns are narrow, body prose spans full text width.
    PROSE_WIDTH_FRAC = 0.70

    for cap_idx, p in enumerate(paras):
        if not p.bbox or not p.page_height:
            continue
        if not _FIGURE_CAPTION_RE.match(p.text):
            continue
        cap_x0, cap_y0, cap_x1, cap_y1 = p.bbox
        page_h = p.page_height
        cap_height = cap_y1 - cap_y0
        is_table = bool(_TABLE_CAPTION_RE.match(p.text))
        walk_threshold = max(cap_height * 1.5, 20.0)

        m = _FIGURE_CAPTION_RE.match(p.text)
        prefix = m.group(0) if m else p.text[:12]

        if is_table:
            # ── Table: caption above, cells below. Walk DOWN. ──────────────
            page_boxes = by_page.get(p.page, [])
            # Compute the page's widest paragraph extent for the prose-width
            # cutoff. Cap-width is usually close to this but not always
            # (single-column table-only pages have a short caption).
            page_max_width = max(
                (q.bbox[2] - q.bbox[0] for _, q in page_boxes),
                default=cap_x1 - cap_x0,
            )
            prose_width = PROSE_WIDTH_FRAC * page_max_width

            below = [
                (qi, q) for qi, q in page_boxes
                if q is not p and q.bbox is not None and q.bbox[3] <= cap_y0
            ]
            # Closest below first: largest y1 (top edge nearest caption).
            below.sort(key=lambda qi_q: -qi_q[1].bbox[3])

            def _is_prose(box) -> bool:
                """Distinguish a body-prose paragraph from a wide table-row
                block. Width alone isn't enough under MuPDF's layout engine:

                  - A row of a multi-column table comes out as ONE wide
                    block ("MMLU-Pro (EM) 89.1 87.5 91.0 ..."). Width-only
                    classifies it as prose → table region bailed at
                    cell #0 → empty crop.
                  - A column-header row is also wide ("Benchmark (Metric)
                    # Shots DeepSeek-V3.2 DeepSeek-V4-Flash ...") and has
                    few digits, so a digit-only filter misses it.

                Combined heuristic: a wide block is only prose when it
                carries multi-sentence flow (an "x. X" boundary). Tabular
                rows — header or data — almost never have that structure.
                """
                bx0, _by0, bx1, _by1 = box.bbox
                if (bx1 - bx0) <= prose_width:
                    return False  # narrow → cell
                txt = box.text
                # Strong "this is prose" signal: at least one sentence
                # boundary inside the block.
                if re.search(r"[a-z]\.\s+[A-Z]", txt):
                    return True
                # Mostly digits → tabular data row.
                alpha = sum(1 for c in txt if c.isalpha())
                digit = sum(1 for c in txt if c.isdigit())
                if alpha + digit > 0 and digit / (alpha + digit) > 0.15:
                    return False
                # Wide, no inter-sentence boundary, low digit ratio →
                # column-header row or single-line caption fragment.
                # Default to NOT-prose so the table region keeps growing;
                # the walk_threshold gap check will still bound it.
                return False

            if not below:
                # Caption with nothing below it (page-end caption?). Degenerate.
                pdf_top = cap_y0
                pdf_bottom = cap_y0
            else:
                first_qi, first_q = below[0]
                first_y0, first_y1 = first_q.bbox[1], first_q.bbox[3]
                first_gap = cap_y0 - first_y1
                if first_gap > INITIAL_GAP_MAX or _is_prose(first_q):
                    # Nothing table-shaped near the caption → degenerate crop.
                    pdf_top = cap_y0
                    pdf_bottom = cap_y0
                else:
                    # Accumulate cells. lowest_y0 tracks the bottom of all the
                    # cells we've grouped so far. Side-by-side columns have
                    # overlapping y ranges; the "next box's top must be within
                    # walk_threshold of accumulated bottom" rule handles that
                    # naturally.
                    #
                    # When we hit a prose paragraph below, extend pdf_bottom
                    # down to its TOP edge (not the last cell's bottom). This
                    # captures score grids / charts that pdfminer renders as
                    # graphics (so we don't see them as boxes), but which
                    # visually live in the gap between the last extracted cell
                    # and the next prose paragraph. Capped at PROSE_REACH so
                    # an isolated cell row followed by far-below prose doesn't
                    # over-extend.
                    PROSE_REACH = 250.0
                    pdf_top = cap_y0
                    lowest_y0 = first_y0
                    pdf_bottom = first_y0  # default: stop at last extracted cell
                    drop.add(first_qi)
                    for qi, q in below[1:]:
                        qy0, qy1 = q.bbox[1], q.bbox[3]
                        # Stop at the next Table/Figure caption — that marks
                        # the end of THIS table's region. Without this guard
                        # we'd swallow the next caption (so Table 3 below
                        # Table 2 gets dropped from translation, leaving the
                        # bilingual reader with no Chinese for it).
                        if _FIGURE_CAPTION_RE.match(q.text):
                            pdf_bottom = max(qy1, lowest_y0)
                            break
                        if _is_prose(q):
                            # Reach down to top-of-prose if it's close enough.
                            if (lowest_y0 - qy1) <= PROSE_REACH:
                                pdf_bottom = qy1
                            else:
                                pdf_bottom = lowest_y0
                            break
                        if qy1 < lowest_y0 - walk_threshold:
                            pdf_bottom = lowest_y0
                            break  # clean visual break = end of table
                        lowest_y0 = min(lowest_y0, qy0)
                        pdf_bottom = lowest_y0
                        drop.add(qi)
        else:
            # ── Figure: caption below, image above. Walk UP. ───────────────
            # We anchor the crop's top at the nearest "real" block above the
            # caption — meaning a prose paragraph / heading, not a chart
            # axis label.
            #
            # MuPDF's layout engine extracts every visible text run, so a
            # bar chart on the page above a Figure caption produces dozens
            # of tiny blocks ("57.9", "Apex Shortlist", "Token Position
            # (K)", etc.) sitting INSIDE what we want to crop. The naive
            # "nearest above-block" rule then anchors the crop's top on a
            # 6pt-tall axis label right above the caption, leaving a 12pt
            # crop that contains nothing useful.
            #
            # Width filter: a block is only used as an anchor when it
            # spans ≥ 50% of the page's widest extent. Real paragraphs
            # easily clear that bar; axis labels and individual data
            # points don't.
            #
            # Once the figure region is bounded, we also DROP every text
            # block that sits inside it from the translation pipeline —
            # otherwise "0.4", "DeepSeek-V4-Pro", "Token Position (K)" each
            # become their own translated <article>, polluting the
            # bilingual reading flow with chart label fragments.
            page_boxes = by_page.get(p.page, [])
            page_max_width = max(
                (q.bbox[2] - q.bbox[0] for _, q in page_boxes),
                default=cap_x1 - cap_x0,
            )
            min_anchor_width = page_max_width * 0.5

            nearest_y0 = page_h
            nearest_dist = float("inf")
            for qi, q in page_boxes:
                if q is p or q.bbox is None:
                    continue
                qx0, qy0, qx1, qy1 = q.bbox
                if qy0 < cap_y1:
                    continue  # below the caption, ignore
                if (qx1 - qx0) < min_anchor_width:
                    continue  # narrow → likely a figure-internal label
                dist = qy0 - cap_y1
                if dist < nearest_dist:
                    nearest_dist = dist
                    nearest_y0 = qy0
            pdf_top = nearest_y0
            pdf_bottom = cap_y1
            # Drop every (narrow) text block inside the figure region from
            # the translation pipeline — but never another Figure/Table
            # caption, since that's its OWN bilingual unit and needs its
            # own translation. Wide blocks (paragraphs / headings) inside
            # this region are rare; the strict-inequality bbox test below
            # filters them out alongside the anchor itself.
            for qi, q in page_boxes:
                if q is p or q.bbox is None:
                    continue
                if _FIGURE_CAPTION_RE.match(q.text):
                    continue
                qx0, qy0, qx1, qy1 = q.bbox
                if qy0 >= cap_y1 and qy1 <= pdf_top:
                    drop.add(qi)

        crops.append(FigureCrop(
            page=p.page,
            caption_text_prefix=prefix,
            pdf_top=pdf_top,
            pdf_bottom=pdf_bottom,
            page_height=page_h,
        ))
    return crops, drop


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


def render_figure_crops(pdf_bytes: bytes, crops: list[FigureCrop], *, dpi: int = 130) -> list[bytes]:
    """Rasterize each FigureCrop's region into a PNG. Returned in the same
    order as `crops`. Slightly higher DPI than the per-page render (130 vs
    110) since these are smaller crops that often contain finer detail
    (chart axis labels, equation glyphs)."""
    import io
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(pdf_bytes)
    out: list[bytes] = []
    try:
        scale = dpi / 72.0
        # Render each unique page once, reuse for multiple crops on it.
        by_page: dict[int, "object"] = {}
        for c in crops:
            page_idx0 = c.page - 1
            if page_idx0 not in by_page:
                page = pdf[page_idx0]
                # Render full page → PIL once, reuse for crops on this page.
                pil = page.render(scale=scale).to_pil()
                page.close()
                by_page[page_idx0] = pil
            pil = by_page[page_idx0]
            page_h_px = pil.height
            # PDF coords have y=0 at bottom; pixel y=0 is at top. Flip.
            top_px = max(0, int(round((c.page_height - c.pdf_top) * scale)))
            bot_px = min(page_h_px, int(round((c.page_height - c.pdf_bottom) * scale)))
            # Tiny ranges = no actual figure (nearest text box was right above
            # the caption, e.g., a continuation of body text). Emit empty bytes
            # so the index alignment with main.py's caption iteration holds;
            # main.py treats empty bytes as "no inline figure for this caption".
            if bot_px <= top_px or (bot_px - top_px) < 40:
                out.append(b"")
                continue
            # Add a few pixels of padding so the figure isn't pixel-tight.
            pad = 4
            top_px = max(0, top_px - pad)
            bot_px = min(page_h_px, bot_px + pad)
            crop_pil = pil.crop((0, top_px, pil.width, bot_px))
            buf = io.BytesIO()
            crop_pil.save(buf, format="PNG", optimize=True)
            out.append(buf.getvalue())
    finally:
        pdf.close()
    return out
