from __future__ import annotations

from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


def safe_return_path(value: str | None, default: str = "/") -> str:
    """Return a same-origin path suitable for an OAuth post-login redirect."""
    if not value or not isinstance(value, str):
        return default

    candidate = value.strip()
    if not candidate or any(ord(char) < 32 for char in candidate):
        return default
    if "\\" in candidate or candidate.startswith("//"):
        return default

    try:
        parsed = urlsplit(candidate)
    except ValueError:
        return default

    if parsed.scheme or parsed.netloc or not parsed.path.startswith("/"):
        return default
    return urlunsplit(("", "", parsed.path, parsed.query, parsed.fragment))


def add_access_token_fragment(path: str, access_token: str) -> str:
    """Put the short-lived JWT in the URL fragment, outside HTTP logs/referrers."""
    target = safe_return_path(path)
    parsed = urlsplit(target)
    fragment_items = [
        (key, value)
        for key, value in parse_qsl(parsed.fragment, keep_blank_values=True)
        if key != "access_token"
    ]
    fragment_items.append(("access_token", access_token))
    return urlunsplit(("", "", parsed.path, parsed.query, urlencode(fragment_items)))
