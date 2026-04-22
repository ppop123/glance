"""Prompt templates. Keep small — complexity here = tokens wasted on every call.

The batch format is a numbered list; response must return the same indices.
Model is instructed to output ONLY the translated lines with the same markers,
so parsing is line-based and robust.

Topic dispatch:
    - build_messages(texts, target_lang=, site=, topic=)
    - if the caller passes an explicit `topic`, use that hint
    - otherwise, infer topic from `site` via SITE_TOPIC_RULES (rough URL match)
    - otherwise fall back to generic prompt
"""
from __future__ import annotations

import re

SYSTEM_BASE = (
    "You are a professional translator. Translate the user's text to {target_lang}.\n"
    "Protocol:\n"
    " - The input contains multiple ITEMS. Each item starts with a marker like ⟦1⟧, ⟦2⟧.\n"
    " - Items are separated by a line containing exactly ===.\n"
    " - An item may span MULTIPLE lines; preserve every line break inside an item verbatim.\n"
    "Output rules:\n"
    " (1) Output ONLY the translated items, in the same order, using the SAME protocol.\n"
    " (2) Start each translated item with the exact same marker (⟦1⟧, ⟦2⟧, ...).\n"
    " (3) Separate items with a line containing exactly ===.\n"
    " (4) Preserve ALL line breaks inside an item. Do not merge paragraphs.\n"
    " (5) Do not translate code, URLs, @mentions, #hashtags, emoji.\n"
    " (6) No explanations, no commentary, no leading text.\n"
    " (7) If an item is ALREADY in {target_lang}, output it unchanged with its marker.\n"
    " (8) IMPORTANT: Japanese text (contains hiragana/katakana OR Japanese-specific vocabulary even if kanji-heavy) and Korean text (contains hangul) are NOT Chinese — always translate them to {target_lang}.\n"
    " (9) IMPORTANT: Traditional Chinese and Simplified Chinese are BOTH Chinese — when target is zh-CN, convert Traditional to Simplified; when target is zh-TW, convert Simplified to Traditional."
)

# Topic hints prepended as additional context.
# Key insight: specialized jargon is worth explaining more than general tone.
TOPIC_HINTS: dict[str, str] = {
    "social": (
        "Genre: informal social media post. Keep casual tone, slang, and emoji. "
        "Preserve @handles, #hashtags, $tickers, and URLs verbatim. Do NOT translate 'RT' or 'OP'."
    ),
    "code": (
        "Genre: software engineering. Preserve `inline code`, ```code blocks```, shell commands, "
        "file paths, API names, CLI flags, version numbers, and markdown syntax verbatim. "
        "Translate prose around code faithfully; keep technical terms (e.g. 'race condition', "
        "'commit', 'pull request') with their established Chinese renderings when target is zh, "
        "otherwise leave them as-is."
    ),
    "academic": (
        "Genre: academic paper / preprint. Preserve LaTeX math ($...$, \\begin{...}, \\cite), citations "
        "(Author et al., 2023), equation numbers, dataset names, and model names verbatim. Use formal, "
        "precise phrasing. Keep technical terminology faithful — prefer established discipline-standard "
        "translations over literal word-by-word."
    ),
    "finance": (
        "Genre: finance / markets / investing. Preserve tickers ($AAPL, 700.HK), numeric values, "
        "percentages, currency symbols, and company/fund names verbatim. Use standard financial "
        "terminology (basis points, yield, EBITDA, leverage) with established Chinese renderings "
        "when target is zh."
    ),
    "news": (
        "Genre: news article. Use neutral, factual tone. Preserve proper nouns, quoted speech, "
        "datelines, and agency attributions (Reuters, AP, AFP). Keep sentence boundaries clean."
    ),
    "legal": (
        "Genre: legal / regulatory / policy. Use precise, conservative phrasing. Preserve clause "
        "numbers, statute names, case citations, and defined terms in Title Case. Do not add or "
        "remove qualifiers; translate 'shall', 'may', 'must' with their discipline-standard force."
    ),
    "medical": (
        "Genre: medical / clinical. Preserve drug names (generic and brand), dosages, units "
        "(mg, mL, IU), ICD codes, gene symbols, and Latin anatomical terms verbatim. Use "
        "established medical terminology; when ambiguous, prefer the standard Chinese rendering."
    ),
    "game": (
        "Genre: game / entertainment. Preserve proper nouns for characters, skills, items, "
        "and in-game currency. Keep tone colloquial; jargon like 'boss', 'buff', 'nerf' often "
        "stays in English in Chinese gaming communities — leave them unless clearly translated."
    ),
}

# Regex → topic. First match wins.
# Host patterns are matched against the bare hostname (no scheme/path).
HOST_TOPIC_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"(^|\.)(x|twitter)\.com$", re.I), "social"),
    (re.compile(r"(^|\.)(reddit|ycombinator|hackernews|mastodon|threads|bsky|weibo)\.", re.I), "social"),
    (re.compile(r"(^|\.)(github|gitlab|bitbucket|stackoverflow|stackexchange)\.", re.I), "code"),
    (re.compile(r"(^|\.)(npmjs|pypi|crates\.io|rubygems|pkg\.go\.dev|docs\.rs|devdocs)\.", re.I), "code"),
    (re.compile(r"(^|\.)(arxiv|biorxiv|medrxiv|nature|sciencemag|cell|pubmed|nih|semanticscholar)\.", re.I), "academic"),
    (re.compile(r"(^|\.)(bloomberg|ft\.com|wsj|reuters|cnbc|seekingalpha|marketwatch|yahoo\.com/finance)", re.I), "finance"),
    (re.compile(r"(^|\.)(sec\.gov|federalregister|eur-lex|courtlistener)\.", re.I), "legal"),
    (re.compile(r"(^|\.)(mayoclinic|webmd|drugs\.com|nejm|thelancet|who\.int)\.", re.I), "medical"),
    (re.compile(r"(^|\.)(steam|ign|gamespot|polygon|kotaku|bilibili)\.", re.I), "game"),
    (re.compile(r"(^|\.)(nytimes|washingtonpost|cnn|bbc|guardian|theatlantic|theverge|npr|apnews)", re.I), "news"),
]


def infer_topic(site: str | None) -> str | None:
    if not site:
        return None
    host = site.lower().strip()
    for pat, topic in HOST_TOPIC_RULES:
        if pat.search(host):
            return topic
    return None


# ── Content-based classification ───────────────────────────────────────────
# Each topic has (a) single-word terms matched with word boundaries, weight 1,
# and (b) multi-word phrases matched as substrings, weight 3 (much rarer → stronger signal).
# Keywords chosen for English source text; Chinese source is usually passed through anyway.
#
# Tuning rule: the winner must score at least `MIN_WINNER_SCORE` and beat the
# runner-up by at least `MARGIN`. Short inputs (< MIN_TOTAL_CHARS) are skipped
# because they're too noisy.

CLASSIFIER_KEYWORDS: dict[str, tuple[list[str], list[str]]] = {
    # topic: (single words, phrases)
    "code": (
        [
            "function", "class", "const", "async", "await", "import", "export",
            "module", "struct", "enum", "interface", "return", "throw", "catch",
            "npm", "pip", "cargo", "docker", "kubernetes", "regex", "commit",
            "branch", "merge", "rebase", "deploy", "linter", "eslint", "prettier",
            "typescript", "python", "rust", "golang", "java", "swift",
            "compiler", "transpiler", "bundler", "webpack", "vite",
            "api", "endpoint", "handler", "middleware", "framework", "library",
            "repo", "repository", "pr", "issue", "bug", "patch",
        ],
        [
            "pull request", "stack trace", "source code", "unit test", "integration test",
            "race condition", "memory leak", "null pointer", "type error",
            "continuous integration", "feature flag", "code review",
            "build failed", "rollback", "hotfix",
        ],
    ),
    "academic": (
        [
            "dataset", "benchmark", "baseline", "ablation", "hyperparameter", "epoch",
            "transformer", "attention", "embedding", "fine-tune", "finetune",
            "pretrain", "pretraining", "downstream", "zero-shot", "few-shot",
            "sota", "arxiv", "preprint", "corpus", "model",
            "accuracy", "precision", "recall", "bleu", "rouge", "perplexity",
            "gradient", "optimizer", "regularization", "overfitting",
            "theorem", "proof", "lemma", "corollary", "proposition",
            "hypothesis", "experiment", "evaluation", "analysis",
        ],
        [
            "we propose", "we present", "we show", "in this paper", "our method",
            "our approach", "state of the art", "state-of-the-art",
            "learning rate", "training data", "validation set", "test set",
            "et al", "prior work", "related work",
        ],
    ),
    "finance": (
        [
            "stock", "shares", "bond", "yield", "bonds", "equity", "equities",
            "earnings", "revenue", "ebitda", "eps", "dividend", "ipo", "spinoff",
            "valuation", "pe", "pb", "roe", "roi", "roa", "alpha", "beta",
            "hedge", "fund", "etf", "treasuries", "treasury", "futures", "options",
            "bullish", "bearish", "rally", "selloff", "volatility", "vix",
            "inflation", "deflation", "cpi", "gdp", "recession",
            "fed", "fomc", "powell", "rate", "rates",
            "tickers", "nasdaq", "nyse", "sp500", "dowjones",
            "quarterly", "fiscal",
        ],
        [
            "earnings call", "price target", "guidance cut", "guidance raise",
            "market cap", "free cash flow", "basis points", "rate hike", "rate cut",
            "year over year", "quarter over quarter", "fiscal year",
            "analyst rating", "buy rating", "sell rating", "hold rating",
            "bull market", "bear market", "stock split",
        ],
    ),
    "medical": (
        [
            "patient", "patients", "diagnosis", "symptom", "symptoms", "treatment",
            "clinical", "trial", "placebo", "prescription", "therapy", "surgery",
            "pathology", "oncology", "cardiology", "neurology", "pediatric",
            "disease", "syndrome", "chronic", "acute", "benign", "malignant",
            "prognosis", "mortality", "morbidity", "randomized",
            "drug", "dose", "dosage", "mg", "ml", "iu",
            "fda", "who", "vaccine", "antibody", "antigen", "gene",
            "tumor", "cancer", "cardiac", "renal", "hepatic",
        ],
        [
            "clinical trial", "double blind", "randomized controlled", "adverse event",
            "side effect", "drug interaction", "blood pressure", "heart rate",
            "study population", "primary endpoint", "informed consent",
        ],
    ),
    "legal": (
        [
            "plaintiff", "defendant", "court", "appellate", "appellant", "appellee",
            "ruling", "judgment", "verdict", "jurisdiction", "statute", "statutes",
            "clause", "hereby", "pursuant", "whereas", "therein", "heretofore",
            "breach", "liability", "damages", "injunction", "tort", "felony", "misdemeanor",
            "subpoena", "deposition", "affidavit", "testimony",
            "counsel", "attorney", "prosecutor", "judge", "justice",
            "constitutional", "unconstitutional", "legislation", "regulation", "regulatory",
            "sec", "ftc", "doj", "ftca",
        ],
        [
            "per se", "prima facie", "amicus curiae", "res judicata",
            "due process", "stare decisis", "motion to dismiss", "motion for",
            "class action", "cease and desist", "in accordance with",
            "shall not", "may not", "subject to",
        ],
    ),
    "game": (
        [
            "boss", "loot", "raid", "quest", "dlc", "patch", "expansion",
            "meta", "ranked", "unranked", "casual", "hardcore", "pvp", "pve",
            "fps", "rpg", "mmo", "rts", "moba", "tcg", "ccg",
            "esports", "streamer", "twitch", "youtube", "clip",
            "skin", "cosmetic", "battle", "pass", "achievement", "trophy",
            "nerf", "buff", "rework", "balance",
            "controller", "keyboard", "mouse", "latency", "ping", "fps",
            "steam", "xbox", "playstation", "switch", "nintendo",
        ],
        [
            "battle royale", "game of the year", "open world", "early access",
            "review score", "season pass", "skill tree", "talent tree",
            "day one", "launch day", "pre order",
        ],
    ),
    "social": (
        [
            "retweet", "rt", "followers", "following", "viral",
            "thread", "quote", "subtweet", "reply", "replies",
            "meme", "vibe", "vibes", "based", "cringe", "ratio",
            "lol", "lmao", "imo", "tbh", "ngl", "fwiw", "btw", "smh",
            "engagement", "trending",
        ],
        [
            "hot take", "take on", "thoughts on", "y'all", "you guys",
            "ratio'd", "quote tweet",
        ],
    ),
    "news": (
        [
            "reporters", "reuters", "ap", "afp", "xinhua", "bloomberg",
            "spokesperson", "officials", "president", "prime minister", "minister",
            "parliament", "congress", "senate", "house",
            "agency", "ministry", "bureau", "department",
            "investigation", "probe", "announcement", "statement",
            "protest", "rally", "strike", "elections",
            "sanctions", "embargo", "treaty", "summit", "summit",
        ],
        [
            "according to sources", "a senior official", "officials said",
            "press conference", "press release", "on condition of anonymity",
            "breaking news", "developing story",
        ],
    ),
}

MIN_TOTAL_CHARS = 120
MIN_WINNER_SCORE = 3
MARGIN = 1.8  # winner must score ≥ runner_up * MARGIN + 1


def classify_from_text(texts: list[str]) -> str | None:
    """Score-based topic classifier over a bag of English keywords/phrases.
    Returns a topic string or None if signal is too weak."""
    joined = (" ".join(texts)).lower()
    if len(joined) < MIN_TOTAL_CHARS:
        return None
    scores: dict[str, int] = {}
    for topic, (words, phrases) in CLASSIFIER_KEYWORDS.items():
        s = 0
        for w in words:
            # word boundaries so "the" doesn't false-match "thesaurus"
            s += len(re.findall(rf"\b{re.escape(w)}\b", joined))
        for p in phrases:
            s += joined.count(p.lower()) * 3
        if s:
            scores[topic] = s
    if not scores:
        return None
    best = max(scores.items(), key=lambda kv: kv[1])
    if best[1] < MIN_WINNER_SCORE:
        return None
    runner = max((v for k, v in scores.items() if k != best[0]), default=0)
    if best[1] < runner * MARGIN + 1:
        return None
    return best[0]


def resolve_topic(*, texts: list[str], site: str | None, topic: str | None) -> tuple[str | None, str]:
    """Return (resolved_topic, reason).  Priority:  explicit → content → host."""
    if topic:
        return topic, "explicit"
    t = classify_from_text(texts)
    if t:
        return t, "content"
    t = infer_topic(site)
    if t:
        return t, "host"
    return None, "none"


# Markers use rare Unicode brackets so they don't collide with source text.
MARK_OPEN = "\u27e6"   # ⟦
MARK_CLOSE = "\u27e7"  # ⟧
ITEM_SEP = "==="       # delimits items; placed on its own line


def format_batch(texts: list[str]) -> str:
    """Each item on its own 'block':  ⟦N⟧\\n<content-with-real-newlines>\\n===\\n..."""
    chunks: list[str] = []
    for i, t in enumerate(texts, 1):
        clean = (t or "").replace("\r\n", "\n").replace("\r", "\n").strip("\n")
        chunks.append(f"{MARK_OPEN}{i}{MARK_CLOSE}\n{clean}")
    return f"\n{ITEM_SEP}\n".join(chunks)


_MARKER_RE = re.compile(rf"^{re.escape(MARK_OPEN)}(\d+){re.escape(MARK_CLOSE)}\s*$")


def parse_batch(output: str, expected_n: int) -> list[str | None]:
    """Parse multi-line items separated by === and starting with ⟦N⟧ on its own line
    (or at the start of a line with inline content). Tolerates slight model drift."""
    result: list[str | None] = [None] * expected_n
    if not output:
        return result

    # Normalize potential stray "⏎" / "↵" paragraph-symbol characters (old protocol leak).
    output = output.replace("\u23ce", "\n").replace("\u21b5", "\n").replace("\u2b90", "\n")

    lines = output.replace("\r\n", "\n").split("\n")
    cur_idx: int | None = None
    cur_buf: list[str] = []

    def flush() -> None:
        nonlocal cur_idx, cur_buf
        if cur_idx is not None and 1 <= cur_idx <= expected_n:
            result[cur_idx - 1] = "\n".join(cur_buf).strip("\n").rstrip()
        cur_idx = None
        cur_buf = []

    for raw in lines:
        stripped = raw.strip()
        # Item separator
        if stripped == ITEM_SEP:
            flush()
            continue
        # Marker line — may be on its own or followed inline by content
        m = _MARKER_RE.match(stripped)
        if m:
            flush()
            cur_idx = int(m.group(1))
            continue
        # Inline marker at start: "⟦N⟧ some text"
        if stripped.startswith(MARK_OPEN):
            close = stripped.find(MARK_CLOSE)
            if close > 1:
                try:
                    idx = int(stripped[1:close])
                except ValueError:
                    idx = None
                if idx is not None:
                    flush()
                    cur_idx = idx
                    tail = stripped[close + 1:].lstrip()
                    if tail:
                        cur_buf.append(tail)
                    continue
        # Regular content line — append (preserve leading spaces from raw, not stripped)
        if cur_idx is not None:
            cur_buf.append(raw)
    flush()
    return result


def build_messages(
    texts: list[str],
    *,
    target_lang: str,
    site: str | None = None,
    topic: str | None = None,
) -> tuple[list[dict], str | None, str]:
    """Returns (messages, resolved_topic, reason).
    `reason` is one of: 'explicit' | 'content' | 'host' | 'none'."""
    resolved, reason = resolve_topic(texts=texts, site=site, topic=topic)
    sys = SYSTEM_BASE.format(target_lang=target_lang)
    if resolved and resolved in TOPIC_HINTS:
        sys = sys + "\n\nContext: " + TOPIC_HINTS[resolved]
    msgs = [
        {"role": "system", "content": sys},
        {"role": "user", "content": format_batch(texts)},
    ]
    return msgs, resolved, reason
