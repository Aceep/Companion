"""Spotify's OAuth side: PKCE helpers and the token endpoint, shared by `--login spotify` and the watcher."""

import base64
import hashlib
import json
import secrets
import urllib.parse
from dataclasses import dataclass
from typing import TYPE_CHECKING

# Only for annotations: the watchers package imports this module.
if TYPE_CHECKING:
    from .watchers.http import Transport

AUTHORIZE_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
SCOPES = "user-read-currently-playing user-read-playback-state"
FORM_HEADERS = {"Content-Type": "application/x-www-form-urlencoded"}


@dataclass(frozen=True)
class TokenGrant:
    access_token: str
    expires_in_s: float
    # Present when Spotify rotates the refresh token.
    refresh_token: str | None


class TokenEndpointError(Exception):
    """The token endpoint refused, or answered something unusable. The message is safe to log."""

    def __init__(self, message: str, status: int = 0, error: str = "", retry_after_s: float | None = None):
        super().__init__(message)
        self.status = status
        self.error = error
        self.retry_after_s = retry_after_s


def redirect_uri(port: int) -> str:
    # Spotify only accepts an IP literal for a loopback http redirect: "localhost" is refused.
    return f"http://127.0.0.1:{port}/callback"


def new_code_verifier() -> str:
    # 64 random bytes give 86 URL-safe characters; RFC 7636 allows 43 to 128.
    return secrets.token_urlsafe(64)


def new_state() -> str:
    return secrets.token_urlsafe(24)


def code_challenge(verifier: str) -> str:
    """S256 challenge: base64url without padding of the SHA-256 of the verifier (RFC 7636, 4.2)."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def build_authorize_url(client_id: str, port: int, challenge: str, state: str, base_url: str = AUTHORIZE_URL) -> str:
    query = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "response_type": "code",
            "redirect_uri": redirect_uri(port),
            "code_challenge_method": "S256",
            "code_challenge": challenge,
            "state": state,
            "scope": SCOPES,
        }
    )
    return f"{base_url}?{query}"


def exchange_code(
    transport: "Transport", client_id: str, port: int, code: str, verifier: str, token_url: str = TOKEN_URL
) -> TokenGrant:
    return _post_token(
        transport,
        token_url,
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri(port),
            "client_id": client_id,
            "code_verifier": verifier,
        },
    )


def refresh_access_token(
    transport: "Transport", client_id: str, refresh_token: str, token_url: str = TOKEN_URL
) -> TokenGrant:
    return _post_token(
        transport,
        token_url,
        {"grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": client_id},
    )


def _post_token(transport: "Transport", token_url: str, form: dict[str, str]) -> TokenGrant:
    response = transport.request("POST", token_url, FORM_HEADERS, urllib.parse.urlencode(form).encode("ascii"))
    payload = _json_object(response.body)
    if response.status != 200:
        error = str(payload.get("error", ""))
        description = str(payload.get("error_description") or payload.get("error", "")) if payload else ""
        # Whether Spotify accepts PKCE for a dev-mode app is not documented: say what it answered, verbatim.
        detail = f"{error}: {description}" if error and description != error else (error or "no details")
        raise TokenEndpointError(
            f"Spotify's token endpoint answered HTTP {response.status} ({detail})",
            status=response.status,
            error=error,
            retry_after_s=_retry_after(response.headers),
        )
    access_token = payload.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise TokenEndpointError("Spotify's token endpoint answered 200 without an access_token", status=200)
    expires_in = payload.get("expires_in")
    rotated = payload.get("refresh_token")
    return TokenGrant(
        access_token=access_token,
        expires_in_s=float(expires_in) if isinstance(expires_in, (int, float)) and not isinstance(expires_in, bool) else 3600.0,
        refresh_token=rotated if isinstance(rotated, str) and rotated else None,
    )


def _json_object(body: bytes) -> dict:
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _retry_after(headers: dict[str, str]) -> float | None:
    try:
        return max(0.0, float(headers["retry-after"]))
    except (KeyError, ValueError):
        return None
