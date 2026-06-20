import ipaddress
from urllib.parse import urlsplit, urlunsplit


LOOPBACK_ASSET_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}


def _is_private_or_loopback_host(hostname: str | None) -> bool:
    if not hostname:
        return True
    lowered = hostname.lower().rstrip(".")
    if lowered in LOOPBACK_ASSET_HOSTS or lowered.endswith(".local"):
        return True
    try:
        address = ipaddress.ip_address(lowered)
    except ValueError:
        return False
    return address.is_private or address.is_loopback or address.is_unspecified


def select_public_base_url(configured_url: str | None, request_base_url: str) -> str:
    """Prefer the real public request origin over a stale private configuration."""
    request_base = request_base_url.strip().rstrip("/")
    configured = (configured_url or "").strip().rstrip("/")

    try:
        request_host = urlsplit(request_base).hostname
    except ValueError:
        request_host = None

    if request_host and not _is_private_or_loopback_host(request_host):
        return request_base

    if configured:
        try:
            parsed_configured = urlsplit(configured)
            if parsed_configured.scheme in {"http", "https"} and parsed_configured.netloc:
                return configured
        except ValueError:
            pass
    return request_base


def normalize_browser_asset_url(value: str | None) -> str | None:
    """Turn server-local absolute URLs into browser-safe same-origin URLs."""
    if not value or not isinstance(value, str):
        return value

    stripped = value.strip()
    try:
        parsed = urlsplit(stripped)
    except ValueError:
        return stripped

    if parsed.hostname and parsed.hostname.lower() in LOOPBACK_ASSET_HOSTS:
        path = parsed.path or "/"
        return urlunsplit(("", "", path, parsed.query, parsed.fragment))
    return stripped
