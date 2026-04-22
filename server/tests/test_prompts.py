"""Prompt batch protocol: numbered markers + === separators. These are the
grammar the LLM is supposed to return, so if we drift on either side the whole
batch silently fails to parse."""
from __future__ import annotations

from app.prompts import format_batch, parse_batch, build_messages


def test_format_batch_uses_numbered_markers():
    out = format_batch(["hi", "there"])
    assert "⟦1⟧" in out and "⟦2⟧" in out
    assert "===" in out


def test_parse_batch_round_trip():
    texts = ["first line", "second line\nwith break", "third"]
    formatted = format_batch(texts)
    # The LLM's real output would be translated text — we cheat and feed the
    # same format back in to verify the parser round-trips.
    parsed = parse_batch(formatted, len(texts))
    assert parsed == texts


def test_parse_batch_handles_missing_items():
    content = "⟦1⟧ first\n===\n⟦3⟧ third"  # item 2 missing
    parsed = parse_batch(content, 3)
    assert parsed[0] == "first"
    assert parsed[1] is None
    assert parsed[2] == "third"


def test_build_messages_injects_glossary_when_matched():
    msgs, _, _ = build_messages(
        ["Einstein discovered relativity"],
        target_lang="zh-CN",
        glossary=[("Einstein", "爱因斯坦"), ("unused", "never_matched")],
    )
    sys = msgs[0]["content"]
    assert "Glossary" in sys
    assert "Einstein" in sys
    # Only appears-in-batch entries are attached to keep tokens tight.
    assert "unused" not in sys
    assert "never_matched" not in sys


def test_build_messages_no_glossary_no_section():
    msgs, _, _ = build_messages(["hello"], target_lang="zh-CN", glossary=None)
    assert "Glossary" not in msgs[0]["content"]
