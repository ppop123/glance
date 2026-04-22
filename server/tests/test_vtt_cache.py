"""Host-aware canonical_url: different video providers have different identity
rules (path vs query). Regressions here silently mis-serve cached subtitles."""
from __future__ import annotations

from app.vtt_cache import canonical_url


def test_twitter_normalises_to_x_and_drops_query():
    assert canonical_url("https://twitter.com/user/status/123?s=46") == "https://x.com/user/status/123"
    assert canonical_url("https://mobile.twitter.com/user/status/123") == "https://x.com/user/status/123"
    assert canonical_url("https://m.twitter.com/user/status/123?t=abc") == "https://x.com/user/status/123"


def test_x_drops_query_but_keeps_path():
    assert canonical_url("https://x.com/user/status/123?s=46") == "https://x.com/user/status/123"
    assert canonical_url("https://x.com/user/status/123/") == "https://x.com/user/status/123"


def test_youtube_keeps_only_v_param():
    assert canonical_url("https://www.youtube.com/watch?v=abc123&t=30") == "https://www.youtube.com/watch?v=abc123"
    assert canonical_url("https://youtube.com/watch?v=xyz&list=PL1&si=notme") == "https://youtube.com/watch?v=xyz"
    # No v at all → just base path (won't really happen in practice but shouldn't crash)
    assert canonical_url("https://www.youtube.com/watch").startswith("https://www.youtube.com/watch")


def test_bilibili_keeps_only_p_param():
    # Multipart videos: different ?p= is a different part, must NOT collapse.
    assert canonical_url("https://www.bilibili.com/video/BV1xx?p=1") == "https://www.bilibili.com/video/BV1xx?p=1"
    assert canonical_url("https://www.bilibili.com/video/BV1xx?p=2") == "https://www.bilibili.com/video/BV1xx?p=2"
    assert canonical_url("https://www.bilibili.com/video/BV1xx") == "https://www.bilibili.com/video/BV1xx"


def test_youtu_be_and_other_allowlisted_drop_query():
    # Path-based identity for these hosts — query is only tracking noise.
    assert canonical_url("https://youtu.be/abc?t=30") == "https://youtu.be/abc"
    assert canonical_url("https://vimeo.com/123456?share=1") == "https://vimeo.com/123456"
    assert canonical_url("https://www.ted.com/talks/foo?subtitle=en") == "https://www.ted.com/talks/foo"


def test_unknown_host_keeps_query_conservatively():
    # Any host we haven't classified: keep query so we don't accidentally collapse
    # videos on less-common providers.
    u = "https://someplayer.example/watch?v=abc123"
    assert canonical_url(u) == u
