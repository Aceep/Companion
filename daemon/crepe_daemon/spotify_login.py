"""`--login spotify`: the browser consent flow (Authorization Code with PKCE) on a one-shot loopback server."""

import html
import http.server
import logging
import subprocess
import time
import urllib.parse
from typing import Callable

from . import spotify_auth
from .config import SpotifyConfig
from .watchers.base import WatcherError
from .watchers.http import Transport

log = logging.getLogger(__name__)

LOGIN_TIMEOUT_S = 300
LOOPBACK = "127.0.0.1"
CALLBACK_PATH = "/callback"
SUCCESS_PAGE = "C'est bon, tu peux fermer cet onglet."
FAILURE_PAGE = "Ça n'a pas marché, regarde le terminal."
REJECTED_PAGE = "Requête refusée."


class LoginError(Exception):
    """The login cannot go on. The message is for the terminal."""


def login(
    config: SpotifyConfig,
    transport: Transport,
    store_refresh_token: Callable[[str], None],
    open_url: Callable[[str], None],
    say: Callable[[str], None] = print,
    timeout_s: float = LOGIN_TIMEOUT_S,
    authorize_url: str = spotify_auth.AUTHORIZE_URL,
    token_url: str = spotify_auth.TOKEN_URL,
) -> None:
    verifier = spotify_auth.new_code_verifier()
    state = spotify_auth.new_state()
    url = spotify_auth.build_authorize_url(
        config.client_id, config.redirect_port, spotify_auth.code_challenge(verifier), state, authorize_url
    )
    outcome: dict[str, str] = {}

    def complete(params: dict[str, str]) -> tuple[bool, str]:
        """(done, page): called on every hit of the callback path."""
        if params.get("state") != state:
            # Not from our authorize request: a stray or forged hit must not end the wait.
            log.warning("ignoring a callback whose state does not match")
            return False, REJECTED_PAGE
        if "error" in params:
            outcome["failure"] = f"Spotify refused the authorization: {params['error']}"
            return True, FAILURE_PAGE
        code = params.get("code")
        if not code:
            outcome["failure"] = "the callback carried no authorization code"
            return True, FAILURE_PAGE
        try:
            grant = spotify_auth.exchange_code(transport, config.client_id, config.redirect_port, code, verifier, token_url)
            if not grant.refresh_token:
                raise LoginError("Spotify's answer holds no refresh token")
            store_refresh_token(grant.refresh_token)
        except (spotify_auth.TokenEndpointError, WatcherError, LoginError) as error:
            outcome["failure"] = str(error)
            return True, FAILURE_PAGE
        except Exception as error:
            # Keyring failures and the like: still end the wait, the terminal says why.
            outcome["failure"] = f"could not store the token: {error}"
            return True, FAILURE_PAGE
        return True, SUCCESS_PAGE

    server = _open_server(config.redirect_port, complete)
    try:
        say("Open this address in your browser to connect Spotify:")
        say(url)
        say(f"Waiting up to {round(timeout_s / 60)} min for the answer on {spotify_auth.redirect_uri(config.redirect_port)}...")
        open_url(url)
        _wait(server, timeout_s, outcome)
    finally:
        server.server_close()
    if "failure" in outcome:
        raise LoginError(outcome["failure"])


def _open_server(port: int, complete: Callable[[dict[str, str]], tuple[bool, str]]) -> http.server.HTTPServer:
    server_class = type("CallbackServer", (http.server.HTTPServer,), {"complete": staticmethod(complete), "done": False})
    try:
        return server_class((LOOPBACK, port), _CallbackHandler)
    except OSError as error:
        raise LoginError(
            f"cannot listen on {LOOPBACK}:{port} ({error.strerror or error}); "
            "is another login running? Change redirect_port in daemon.toml and in the Spotify app if needed"
        ) from error


def _wait(server: http.server.HTTPServer, timeout_s: float, outcome: dict[str, str]) -> None:
    deadline = time.monotonic() + timeout_s
    while not server.done:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise LoginError(f"no answer from the browser within {round(timeout_s / 60)} min, nothing stored")
        # Wakes up at least once a second, so a stuck keep-alive socket cannot hide the deadline.
        server.timeout = min(remaining, 1.0)
        server.handle_request()


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parts = urllib.parse.urlsplit(self.path)
        if parts.path != CALLBACK_PATH:
            self._reply(404, "Introuvable.")
            return
        params = {key: values[0] for key, values in urllib.parse.parse_qs(parts.query).items()}
        done, page = self.server.complete(params)
        self.server.done = done
        self._reply(200 if page == SUCCESS_PAGE else 400, page)

    def _reply(self, status: int, message: str) -> None:
        body = f'<!doctype html><html lang="fr"><meta charset="utf-8"><title>Crêpe</title><p>{html.escape(message, quote=False)}</p></html>'
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        # The default writes the request line, which holds the authorization code.
        pass


def open_in_browser(url: str) -> None:
    """Best effort: the URL is printed anyway, so a failure here is not one."""
    try:
        from gi.repository import Gio, GLib

        try:
            if Gio.AppInfo.launch_default_for_uri(url, None):
                return
        except GLib.Error as error:
            log.debug("cannot open the browser through Gio: %s", error.message)
    except ImportError:
        pass
    try:
        subprocess.Popen(["xdg-open", url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as error:
        log.debug("cannot run xdg-open: %s", error)
