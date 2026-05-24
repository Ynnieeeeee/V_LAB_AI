import hmac
import hashlib
import urllib.parse

def generate_secure_hash(params: dict, secret_key: str) -> str:
    params = {k: v for k, v in params.items() if v not in [None, ""]}

    sorted_keys = sorted(params.keys())

    query_string = "&".join(
        f"{key}={urllib.parse.quote_plus(str(params[key]))}"
        for key in sorted_keys
    )

    secure_hash = hmac.new(
        secret_key.encode(),
        query_string.encode(),
        hashlib.sha512
    ).hexdigest()

    return secure_hash

def validate_response(params: dict, secret_key: str):
    secure_hash = params.pop("vnp_SecureHash", None)
    params.pop("vnp_SecureHashType", None)

    if not secure_hash:
        return False

    sorted_keys = sorted(params.keys())

    query_string = "&".join(
        f"{key}={urllib.parse.quote_plus(str(params[key]))}"
        for key in sorted_keys
    )

    calculated_hash = hmac.new(
        secret_key.encode(),
        query_string.encode(),
        hashlib.sha512
    ).hexdigest()

    return calculated_hash == secure_hash