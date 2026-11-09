"""A tiny HTTPS client (JSON or text) on the standard library, swappable in tests."""

import http.client
import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Protocol

from .. import VERSION
from .base import WatcherError

REQUEST_TIMEOUT_S = 20
# A page of issues or a year of calendar is far below this; anything bigger is a wrong URL.
MAX_RESPONSE_BYTES = 5 * 1024 * 1024


@dataclass(frozen=True)
class HttpResponse:
    status: int
    # Header names in lower case.
    headers: dict[str, str]
    body: bytes


class Transport(Protocol):
    def get_json(self, url: str, headers: dict[str, str]) -> object:
        """GET `url` and return the decoded JSON body. Raises WatcherError."""
        ...

    def get_text(self, url: str, headers: dict[str, str]) -> str:
        """GET `url` and return the body as text. Errors name the host only. Raises WatcherError."""
        ...

    def request(self, method: str, url: str, headers: dict[str, str], data: bytes | None = None) -> HttpResponse:
        """Send a request and return the answer whatever its status. Raises WatcherError only when no answer came."""
        ...


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # A redirect would replay the token header to wherever it points.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class UrllibTransport:
    def __init__(self, timeout_s: float = REQUEST_TIMEOUT_S):
        self.timeout_s = timeout_s
        self._opener = urllib.request.build_opener(_NoRedirect)

    def get_json(self, url: str, headers: dict[str, str]) -> object:
        where = _describe(url)
        body = self._fetch(url, {**headers, "Accept": "application/json"}, where)
        try:
            return json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise WatcherError(f"response from {where} is not JSON") from None

    def get_text(self, url: str, headers: dict[str, str]) -> str:
        # Published calendar links carry their secret in the path.
        where = urllib.parse.urlsplit(url).hostname or "?"
        body = self._fetch(url, headers, where)
        try:
            return body.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise WatcherError(f"response from {where} is not UTF-8 text") from None

    def request(self, method: str, url: str, headers: dict[str, str], data: bytes | None = None) -> HttpResponse:
        # For APIs whose status codes mean something (401, 429, 204): the caller decides what each one is.
        where = _describe(url)
        try:
            request = urllib.request.Request(
                url, data=data, method=method, headers={**headers, "User-Agent": f"crepe-daemon/{VERSION}"}
            )
            try:
                with self._opener.open(request, timeout=self.timeout_s) as response:
                    return HttpResponse(response.status, _lower_headers(response.headers), response.read(MAX_RESPONSE_BYTES))
            except urllib.error.HTTPError as error:
                with error:
                    return HttpResponse(error.code, _lower_headers(error.headers), error.read(MAX_RESPONSE_BYTES))
        except urllib.error.URLError as error:
            raise WatcherError(f"cannot reach {where}: {error.reason}") from None
        except (TimeoutError, OSError) as error:
            raise WatcherError(f"cannot reach {where}: {error}") from None
        except (ValueError, http.client.HTTPException) as error:
            raise WatcherError(f"bad URL or response from {where} ({type(error).__name__})") from None

    def _fetch(self, url: str, headers: dict[str, str], where: str) -> bytes:
        try:
            request = urllib.request.Request(url, headers={**headers, "User-Agent": f"crepe-daemon/{VERSION}"})
            with self._opener.open(request, timeout=self.timeout_s) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as error:
            raise WatcherError(f"HTTP {error.code} from {where}") from None
        except urllib.error.URLError as error:
            raise WatcherError(f"cannot reach {where}: {error.reason}") from None
        except (TimeoutError, OSError) as error:
            raise WatcherError(f"cannot reach {where}: {error}") from None
        except (ValueError, http.client.HTTPException) as error:
            # Their messages can quote the whole URL, so only the type is kept.
            raise WatcherError(f"bad URL or response from {where} ({type(error).__name__})") from None
        if len(body) > MAX_RESPONSE_BYTES:
            raise WatcherError(f"response from {where} is too large")
        return body


def build_url(base: str, path: str, params: dict[str, object] | None = None) -> str:
    url = base + path
    if params:
        url += "?" + urllib.parse.urlencode(params, safe=":")
    return url


def _describe(url: str) -> str:
    # Host and path only: enough to tell which call failed.
    parts = urllib.parse.urlsplit(url)
    return f"{parts.netloc}{parts.path}"


def _lower_headers(headers) -> dict[str, str]:
    return {name.lower(): value for name, value in headers.items()}
