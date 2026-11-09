import io
import json
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

from crepe_daemon import spotify_auth
from crepe_daemon.config import ConfigError, SpotifyConfig, parse_config
from crepe_daemon.secrets import KeyringError
from crepe_daemon.spotify_login import LoginError, login
from crepe_daemon.watchers import SpotifyWatcher, StateStore, WatcherError, build_watchers
from crepe_daemon.watchers.http import HttpResponse
from crepe_daemon.watchers.spotify import MIN_SESSION_S, QUOTA_BACKOFF_S

from .test_watchers import FakeScheduler, StateDirTestCase, run_now

API = "https://api.spotify.com/v1/me/player/currently-playing"
TOKEN = spotify_auth.TOKEN_URL
CLIENT_ID = "abc123clientid"


def reply(status: int, payload: object = None, headers: dict | None = None) -> HttpResponse:
    body = b"" if payload is None else json.dumps(payload).encode()
    return HttpResponse(status, {key.lower(): value for key, value in (headers or {}).items()}, body)


def playing(track_id: str = "t1", title: str = "Song", artists: tuple[str, ...] = ("Artist",), **extra) -> HttpResponse:
    payload = {
        "is_playing": True,
        "currently_playing_type": "track",
        "item": {"id": track_id, "name": title, "artists": [{"name": name} for name in artists], "duration_ms": 1000},
    }
    return reply(200, {**payload, **extra})


def granted(access: str = "access-1", refresh: str | None = None, expires_in: int = 3600) -> HttpResponse:
    payload = {"access_token": access, "token_type": "Bearer", "expires_in": expires_in}
    if refresh:
        payload["refresh_token"] = refresh
    return reply(200, payload)


class FakeSpotifyTransport:
    """Answers the player and token endpoints from scripted queues; the last answer repeats."""

    def __init__(self, player: list | None = None, tokens: list | None = None):
        self.player = list(player or [])
        self.tokens = list(tokens or [granted()])
        self.calls: list[tuple[str, str, dict, bytes | None]] = []

    def request(self, method, url, headers, data=None):
        self.calls.append((method, url, dict(headers), data))
        queue = self.tokens if url == TOKEN else self.player
        answer = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(answer, Exception):
            raise answer
        return answer

    def player_calls(self):
        return [call for call in self.calls if call[1] == API]

    def token_forms(self):
        return [dict(urllib.parse.parse_qsl(call[3].decode())) for call in self.calls if call[1] == TOKEN]


class Clock:
    def __init__(self):
        self.seconds = 10_000.0

    def __call__(self):
        return self.seconds

    def advance(self, seconds: float) -> None:
        self.seconds += seconds


class SpotifyWatcherCase(StateDirTestCase):
    def setUp(self):
        super().setUp()
        self.clock = Clock()
        self.stored: list[str] = []
        self.keyring_token = "refresh-1"

    def make(self, transport, **config) -> SpotifyWatcher:
        return SpotifyWatcher(
            SpotifyConfig(client_id=CLIENT_ID, **config),
            transport,
            lambda: self.keyring_token,
            self.stored.append,
            self.record_nudge,
            StateStore(),
            now=self.clock,
        )


class PkceTest(unittest.TestCase):
    def test_challenge_matches_the_rfc_7636_appendix_b_vector(self):
        verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        self.assertEqual(spotify_auth.code_challenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")

    def test_verifier_is_within_the_allowed_length_and_alphabet(self):
        verifier = spotify_auth.new_code_verifier()
        self.assertTrue(43 <= len(verifier) <= 128)
        self.assertRegex(verifier, r"^[A-Za-z0-9\-._~]+$")

    def test_authorize_url_carries_every_required_parameter(self):
        url = spotify_auth.build_authorize_url(CLIENT_ID, 8898, "challenge", "state-1")
        parts = urllib.parse.urlsplit(url)
        query = dict(urllib.parse.parse_qsl(parts.query))
        self.assertEqual(f"{parts.scheme}://{parts.netloc}{parts.path}", "https://accounts.spotify.com/authorize")
        self.assertEqual(
            query,
            {
                "client_id": CLIENT_ID,
                "response_type": "code",
                "redirect_uri": "http://127.0.0.1:8898/callback",
                "code_challenge_method": "S256",
                "code_challenge": "challenge",
                "state": "state-1",
                "scope": "user-read-currently-playing user-read-playback-state",
            },
        )


class SpotifyConfigTest(unittest.TestCase):
    def parse(self, **section):
        return parse_config({"watchers": {"spotify": section}}).spotify

    def test_defaults(self):
        self.assertEqual(self.parse(client_id=" abc "), SpotifyConfig("abc", 8898, 30, 120))

    def test_missing_client_id_is_rejected(self):
        with self.assertRaises(ConfigError):
            self.parse()

    def test_empty_client_id_is_rejected(self):
        with self.assertRaises(ConfigError):
            self.parse(client_id="  ")

    def test_port_out_of_range_is_rejected(self):
        for port in (80, 70000, "8898", True):
            with self.subTest(port=port), self.assertRaises(ConfigError):
                self.parse(client_id="abc", redirect_port=port)

    def test_interval_under_fifteen_seconds_is_rejected(self):
        with self.assertRaises(ConfigError):
            self.parse(client_id="abc", interval_seconds=10)

    def test_dev_mode_allows_a_short_interval(self):
        raw = {"watchers": {"spotify": {"client_id": "abc", "interval_seconds": 5, "idle_interval_seconds": 5}}}
        self.assertEqual(parse_config(raw, dev=True).spotify.interval_seconds, 5)

    def test_idle_interval_shorter_than_the_interval_is_rejected(self):
        with self.assertRaises(ConfigError):
            self.parse(client_id="abc", interval_seconds=60, idle_interval_seconds=30)

    def test_no_section_means_no_watcher(self):
        self.assertIsNone(parse_config({}).spotify)


class SpotifyNudgeTest(SpotifyWatcherCase):
    def test_first_state_is_silent(self):
        watcher = self.make(FakeSpotifyTransport([playing()]))
        self.assertEqual(watcher.tick(), [])

    def test_new_track_gives_a_musique_nudge_with_title_and_artists(self):
        transport = FakeSpotifyTransport([playing("t1"), playing("t2", "Autre titre", ("Ana", "Bo"))])
        watcher = self.make(transport)
        watcher.tick()
        self.assertEqual(watcher.tick(), [("musique", "Autre titre — Ana, Bo")])

    def test_same_track_does_not_repeat(self):
        watcher = self.make(FakeSpotifyTransport([playing("t1"), playing("t1")]))
        watcher.tick()
        self.assertEqual(watcher.tick(), [])

    def test_track_started_after_an_empty_start_is_announced(self):
        watcher = self.make(FakeSpotifyTransport([reply(204), playing("t1")]))
        watcher.tick()
        self.assertEqual(watcher.tick(), [("musique", "Song — Artist")])

    def test_long_text_is_cut(self):
        watcher = self.make(FakeSpotifyTransport([playing("t1"), playing("t2", "T" * 100)]))
        watcher.tick()
        ((_kind, text),) = watcher.tick()
        self.assertEqual(len(text), 60)
        self.assertTrue(text.endswith("…"))

    def test_ad_is_ignored(self):
        ad = reply(200, {"is_playing": True, "currently_playing_type": "ad", "item": None})
        watcher = self.make(FakeSpotifyTransport([playing("t1"), ad, playing("t1")]))
        watcher.tick()
        self.assertEqual(watcher.tick(), [])
        self.assertEqual(watcher.tick(), [])

    def test_ad_between_two_songs_does_not_end_the_session(self):
        ad = reply(200, {"is_playing": True, "currently_playing_type": "ad", "item": None})
        watcher = self.make(FakeSpotifyTransport([playing("t1"), ad, reply(204)]))
        watcher.tick()
        self.clock.advance(MIN_SESSION_S)
        watcher.tick()
        self.clock.advance(60)
        self.assertEqual([kind for kind, _text in watcher.tick()], ["musique_fin"])

    def test_episode_gives_no_nudge(self):
        episode = reply(200, {"is_playing": True, "currently_playing_type": "episode", "item": {"id": "e1", "name": "Pod"}})
        watcher = self.make(FakeSpotifyTransport([reply(204), episode]))
        watcher.tick()
        self.assertEqual(watcher.tick(), [])

    def test_paused_track_gives_no_nudge(self):
        watcher = self.make(FakeSpotifyTransport([reply(204), playing("t1", is_playing=False)]))
        watcher.tick()
        self.assertEqual(watcher.tick(), [])

    def test_204_means_nothing_is_playing(self):
        watcher = self.make(FakeSpotifyTransport([reply(204)]))
        self.assertEqual(watcher.tick(), [])


class SpotifySessionTest(SpotifyWatcherCase):
    def test_stop_after_twenty_minutes_gives_musique_fin_with_the_duration(self):
        watcher = self.make(FakeSpotifyTransport([playing("t1"), playing("t2"), reply(204)]))
        watcher.tick()
        self.clock.advance(47 * 60)
        watcher.tick()
        self.assertEqual(watcher.tick(), [("musique_fin", "47 min")])

    def test_stop_just_before_twenty_minutes_gives_nothing(self):
        watcher = self.make(FakeSpotifyTransport([playing("t1"), reply(204)]))
        watcher.tick()
        self.clock.advance(MIN_SESSION_S - 1)
        self.assertEqual(watcher.tick(), [])

    def test_stop_at_twenty_minutes_gives_musique_fin(self):
        watcher = self.make(FakeSpotifyTransport([playing("t1"), reply(204)]))
        watcher.tick()
        self.clock.advance(MIN_SESSION_S)
        self.assertEqual(watcher.tick(), [("musique_fin", "20 min")])

    def test_musique_fin_is_sent_once(self):
        watcher = self.make(FakeSpotifyTransport([playing("t1"), reply(204)]))
        watcher.tick()
        self.clock.advance(MIN_SESSION_S)
        watcher.tick()
        self.clock.advance(30)
        self.assertEqual(watcher.tick(), [])

    def test_pause_via_is_playing_false_ends_the_session(self):
        watcher = self.make(FakeSpotifyTransport([playing("t1"), playing("t1", is_playing=False)]))
        watcher.tick()
        self.clock.advance(MIN_SESSION_S)
        self.assertEqual([kind for kind, _text in watcher.tick()], ["musique_fin"])

    def test_a_new_session_after_a_stop_counts_from_zero(self):
        watcher = self.make(FakeSpotifyTransport([playing("t1"), reply(204), playing("t2"), reply(204)]))
        watcher.tick()
        self.clock.advance(5 * 60)
        watcher.tick()
        self.clock.advance(MIN_SESSION_S)
        watcher.tick()
        self.clock.advance(MIN_SESSION_S - 1)
        self.assertEqual(watcher.tick(), [])


class SpotifyIntervalTest(SpotifyWatcherCase):
    def test_interval_is_the_configured_one_while_playing(self):
        watcher = self.make(FakeSpotifyTransport([playing()]), interval_seconds=30, idle_interval_seconds=120)
        watcher.tick()
        self.assertEqual(watcher.current_interval_s, 30)

    def test_interval_stays_short_during_the_first_ten_idle_minutes(self):
        watcher = self.make(FakeSpotifyTransport([reply(204)]), interval_seconds=30, idle_interval_seconds=120)
        watcher.tick()
        self.clock.advance(9 * 60)
        watcher.tick()
        self.assertEqual(watcher.current_interval_s, 30)

    def test_interval_switches_to_idle_after_ten_idle_minutes(self):
        watcher = self.make(FakeSpotifyTransport([reply(204)]), interval_seconds=30, idle_interval_seconds=120)
        watcher.tick()
        self.clock.advance(10 * 60)
        watcher.tick()
        self.assertEqual(watcher.current_interval_s, 120)

    def test_interval_goes_back_when_music_starts(self):
        watcher = self.make(FakeSpotifyTransport([reply(204), playing()]), interval_seconds=30, idle_interval_seconds=120)
        watcher.tick()
        self.clock.advance(10 * 60)
        watcher.tick()
        watcher.tick()
        self.assertEqual(watcher.current_interval_s, 30)

    def test_timer_uses_the_idle_interval(self):
        watcher = self.make(FakeSpotifyTransport([reply(204)]), interval_seconds=30, idle_interval_seconds=120)
        scheduler = FakeScheduler()
        watcher.start(run_now, scheduler)
        scheduler.fire()
        self.clock.advance(10 * 60)
        scheduler.fire()
        self.assertEqual(scheduler.delays[-1], 120)


class SpotifyAuthFlowTest(SpotifyWatcherCase):
    def test_access_token_is_requested_with_the_refresh_token_and_client_id(self):
        transport = FakeSpotifyTransport([reply(204)])
        self.make(transport).tick()
        self.assertEqual(
            transport.token_forms(), [{"grant_type": "refresh_token", "refresh_token": "refresh-1", "client_id": CLIENT_ID}]
        )

    def test_access_token_goes_in_the_bearer_header(self):
        transport = FakeSpotifyTransport([reply(204)], [granted("access-9")])
        self.make(transport).tick()
        self.assertEqual(transport.player_calls()[0][2]["Authorization"], "Bearer access-9")

    def test_access_token_is_reused_until_it_nearly_expires(self):
        transport = FakeSpotifyTransport([reply(204)], [granted(expires_in=3600)])
        watcher = self.make(transport)
        watcher.tick()
        self.clock.advance(3000)
        watcher.tick()
        self.assertEqual(len(transport.token_forms()), 1)

    def test_access_token_is_renewed_when_it_nearly_expires(self):
        transport = FakeSpotifyTransport([reply(204)], [granted(expires_in=3600)])
        watcher = self.make(transport)
        watcher.tick()
        self.clock.advance(3560)
        watcher.tick()
        self.assertEqual(len(transport.token_forms()), 2)

    def test_rotated_refresh_token_is_stored(self):
        watcher = self.make(FakeSpotifyTransport([reply(204)], [granted(refresh="refresh-2")]))
        watcher.tick()
        self.assertEqual(self.stored, ["refresh-2"])

    def test_unchanged_refresh_token_is_not_stored_again(self):
        watcher = self.make(FakeSpotifyTransport([reply(204)], [granted(refresh="refresh-1")]))
        watcher.tick()
        self.assertEqual(self.stored, [])

    def test_rotated_token_is_used_for_the_next_refresh(self):
        transport = FakeSpotifyTransport([reply(204)], [granted(refresh="refresh-2", expires_in=100)])
        watcher = self.make(transport)
        watcher.tick()
        self.keyring_token = "refresh-2"
        self.clock.advance(100)
        watcher.tick()
        self.assertEqual(transport.token_forms()[1]["refresh_token"], "refresh-2")

    def test_rotated_token_survives_a_failing_keyring(self):
        def fail(_token):
            raise KeyringError("locked")

        transport = FakeSpotifyTransport([reply(204)], [granted(refresh="refresh-2", expires_in=100)])
        watcher = self.make(transport)
        watcher._token_store = fail
        with self.assertLogs("crepe_daemon.watchers.spotify", level="WARNING"):
            watcher.tick()
        self.clock.advance(100)
        watcher.tick()
        self.assertEqual(transport.token_forms()[1]["refresh_token"], "refresh-2")

    def test_401_refreshes_once_and_retries(self):
        transport = FakeSpotifyTransport([reply(401), playing()], [granted("old"), granted("new")])
        watcher = self.make(transport)
        watcher.tick()
        self.assertEqual([call[2]["Authorization"] for call in transport.player_calls()], ["Bearer old", "Bearer new"])

    def test_second_401_is_a_failed_look(self):
        watcher = self.make(FakeSpotifyTransport([reply(401)]))
        with self.assertRaises(WatcherError):
            watcher.tick()

    def test_invalid_grant_stops_the_watcher_and_says_to_log_in_again(self):
        transport = FakeSpotifyTransport([reply(204)], [reply(400, {"error": "invalid_grant", "error_description": "revoked"})])
        watcher = self.make(transport)
        with self.assertLogs("crepe_daemon.watchers.spotify", level="ERROR") as logs:
            self.assertEqual(watcher.tick(), [])
        self.assertIn("--login spotify", logs.output[0])

    def test_invalid_grant_makes_no_further_request_and_no_further_timer(self):
        transport = FakeSpotifyTransport([reply(204)], [reply(400, {"error": "invalid_grant"})])
        watcher = self.make(transport)
        scheduler = FakeScheduler()
        watcher.start(run_now, scheduler)
        with self.assertLogs("crepe_daemon.watchers.spotify", level="ERROR"):
            scheduler.fire()
        self.assertEqual(len(scheduler.delays), 1)
        self.assertEqual(watcher.tick(), [])
        self.assertEqual(len(transport.calls), 1)

    def test_other_token_errors_are_a_failed_look_with_the_reason(self):
        transport = FakeSpotifyTransport([reply(204)], [reply(400, {"error": "invalid_client", "error_description": "Invalid client"})])
        watcher = self.make(transport)
        with self.assertRaises(WatcherError) as raised:
            watcher.tick()
        self.assertIn("invalid_client", str(raised.exception))

    def test_new_login_in_the_keyring_replaces_the_cached_access_token(self):
        transport = FakeSpotifyTransport([reply(204)], [granted("first"), granted("second")])
        watcher = self.make(transport)
        watcher.tick()
        self.keyring_token = "refresh-after-login"
        watcher.tick()
        self.assertEqual(transport.token_forms()[1]["refresh_token"], "refresh-after-login")

    def test_missing_token_idles_without_a_request(self):
        transport = FakeSpotifyTransport([reply(204)])
        self.keyring_token = None
        watcher = self.make(transport)
        with self.assertLogs("crepe_daemon.watchers.base", level="INFO") as logs:
            self.assertEqual(watcher.tick(), [])
        self.assertIn("--login spotify", logs.output[0])
        self.assertEqual(transport.calls, [])

    def test_network_error_is_a_failed_look_that_backs_off(self):
        watcher = self.make(FakeSpotifyTransport([reply(204)]), interval_seconds=30)
        with self.assertLogs("crepe_daemon.watchers.base", level="WARNING"):
            for _ in range(3):
                watcher._complete(WatcherError("down"))
        self.assertEqual(watcher.current_interval_s, 60)


class SpotifyThrottleTest(SpotifyWatcherCase):
    def test_429_pauses_for_retry_after_without_counting_a_failure(self):
        watcher = self.make(FakeSpotifyTransport([reply(429, {"error": {"status": 429}}, {"Retry-After": "90"})]))
        with self.assertLogs("crepe_daemon.watchers.spotify", level="WARNING"):
            self.assertEqual(watcher.tick(), [])
        self.assertEqual(watcher.current_interval_s, 90)
        self.assertEqual(watcher.failures, 0)

    def test_the_pause_ends_with_the_next_successful_look(self):
        watcher = self.make(FakeSpotifyTransport([reply(429, None, {"Retry-After": "90"}), reply(204)]), interval_seconds=30)
        with self.assertLogs("crepe_daemon.watchers.spotify", level="WARNING"):
            watcher.tick()
        watcher.tick()
        self.assertEqual(watcher.current_interval_s, 30)

    def test_429_without_retry_after_still_waits(self):
        watcher = self.make(FakeSpotifyTransport([reply(429)]))
        with self.assertLogs("crepe_daemon.watchers.spotify", level="WARNING"):
            watcher.tick()
        self.assertGreater(watcher.current_interval_s, 30)

    def test_quota_exceeded_backs_off_for_an_hour(self):
        body = {"error": {"status": 429, "message": "quota", "reason": "QUOTA_EXCEEDED"}}
        watcher = self.make(FakeSpotifyTransport([reply(429, body, {"Retry-After": "5"})]))
        with self.assertLogs("crepe_daemon.watchers.spotify", level="WARNING"):
            watcher.tick()
        self.assertEqual(watcher.current_interval_s, QUOTA_BACKOFF_S)

    def test_throttled_refresh_honours_retry_after(self):
        transport = FakeSpotifyTransport([reply(204)], [reply(429, None, {"Retry-After": "45"})])
        watcher = self.make(transport)
        with self.assertLogs("crepe_daemon.watchers.spotify", level="WARNING"):
            watcher.tick()
        self.assertEqual(watcher.current_interval_s, 45)


class UrllibRequestTest(unittest.TestCase):
    def test_error_status_comes_back_as_an_answer_with_lowercase_headers(self):
        from crepe_daemon.watchers.http import UrllibTransport

        transport = UrllibTransport()
        error = urllib.error.HTTPError(API, 429, "Too Many Requests", {"Retry-After": "7"}, io.BytesIO(b"{}"))
        with mock.patch.object(transport._opener, "open", side_effect=error):
            response = transport.request("GET", API, {})
        self.assertEqual((response.status, response.headers["retry-after"], response.body), (429, "7", b"{}"))

    def test_unreachable_host_raises_a_watcher_error_naming_the_host(self):
        from crepe_daemon.watchers.http import UrllibTransport

        transport = UrllibTransport()
        with mock.patch.object(transport._opener, "open", side_effect=urllib.error.URLError("refused")):
            with self.assertRaises(WatcherError) as raised:
                transport.request("GET", API, {})
        self.assertIn("api.spotify.com", str(raised.exception))


class BuildWatchersTest(StateDirTestCase):
    def test_spotify_section_adds_a_watcher_named_spotify(self):
        config = parse_config({"watchers": {"spotify": {"client_id": "abc"}}})
        pool = build_watchers(config, self.record_nudge, transport=FakeSpotifyTransport())
        self.assertEqual(pool.names, ["spotify"])

    def test_nudger_accepts_the_two_music_kinds(self):
        from crepe_daemon.nudge import KINDS

        self.assertLessEqual({"musique", "musique_fin"}, KINDS)


class FakeTokenServer:
    """A real local HTTP server standing in for accounts.spotify.com/api/token."""

    def __init__(self, status: int = 200, payload: dict | None = None):
        self.requests: list[dict] = []
        outer = self
        answer = payload if payload is not None else {"access_token": "a", "expires_in": 3600, "refresh_token": "refresh-from-login"}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["Content-Length"])
                outer.requests.append(dict(urllib.parse.parse_qsl(self.rfile.read(length).decode())))
                body = json.dumps(answer).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/api/token"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def free_port() -> int:
    probe = HTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    port = probe.server_port
    probe.server_close()
    return port


class LoginFlowTest(unittest.TestCase):
    def setUp(self):
        self.port = free_port()
        self.config = SpotifyConfig(client_id=CLIENT_ID, redirect_port=self.port)
        self.token_server = FakeTokenServer()
        self.addCleanup(self.token_server.close)
        self.stored: list[str] = []
        self.said: list[str] = []
        self.pages: list[tuple[int, str]] = []
        self.browser_threads: list[threading.Thread] = []

    def browser_hits(self, *paths):
        """Returns an open_url that, like a browser, visits each callback path built from the authorize URL's state."""

        def open_url(url: str) -> None:
            state = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))["state"]

            def visit() -> None:
                for path in paths:
                    target = f"http://127.0.0.1:{self.port}{path.format(state=state)}"
                    try:
                        with urllib.request.urlopen(target, timeout=10) as response:
                            self.pages.append((response.status, response.read().decode()))
                    except urllib.error.HTTPError as error:
                        self.pages.append((error.code, error.read().decode()))

            thread = threading.Thread(target=visit)
            thread.start()
            self.browser_threads.append(thread)

        return open_url

    def run_login(self, open_url, timeout_s: float = 10) -> None:
        from crepe_daemon.watchers.http import UrllibTransport

        try:
            login(
                self.config,
                UrllibTransport(),
                self.stored.append,
                open_url,
                say=self.said.append,
                timeout_s=timeout_s,
                token_url=self.token_server.url,
            )
        finally:
            for thread in self.browser_threads:
                thread.join(5)

    def test_callback_with_the_right_state_stores_the_refresh_token(self):
        self.run_login(self.browser_hits("/callback?code=the-code&state={state}"))
        self.assertEqual(self.stored, ["refresh-from-login"])

    def test_code_is_exchanged_with_the_pkce_verifier_and_the_redirect_uri(self):
        self.run_login(self.browser_hits("/callback?code=the-code&state={state}"))
        (form,) = self.token_server.requests
        self.assertEqual(form["grant_type"], "authorization_code")
        self.assertEqual(form["code"], "the-code")
        self.assertEqual(form["client_id"], CLIENT_ID)
        self.assertEqual(form["redirect_uri"], f"http://127.0.0.1:{self.port}/callback")
        authorize_query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(self.said[1]).query))
        self.assertEqual(spotify_auth.code_challenge(form["code_verifier"]), authorize_query["code_challenge"])

    def test_browser_gets_the_french_confirmation_page(self):
        self.run_login(self.browser_hits("/callback?code=the-code&state={state}"))
        self.assertEqual(self.pages[0][0], 200)
        self.assertIn("C'est bon, tu peux fermer cet onglet.", self.pages[0][1])

    def test_authorize_url_is_printed(self):
        self.run_login(self.browser_hits("/callback?code=c&state={state}"))
        self.assertTrue(self.said[1].startswith("https://accounts.spotify.com/authorize?"))

    def test_state_mismatch_is_rejected_and_nothing_is_exchanged(self):
        with self.assertRaises(LoginError), self.assertLogs("crepe_daemon.spotify_login", level="WARNING"):
            self.run_login(self.browser_hits("/callback?code=forged&state=wrong"), timeout_s=1.5)
        self.assertEqual(self.token_server.requests, [])
        self.assertEqual(self.stored, [])
        self.assertEqual(self.pages[0][0], 400)

    def test_a_stray_request_does_not_end_the_wait(self):
        self.run_login(self.browser_hits("/favicon.ico", "/callback?code=c&state={state}"))
        self.assertEqual(self.stored, ["refresh-from-login"])

    def test_denied_consent_fails_with_spotify_reason(self):
        with self.assertRaises(LoginError) as raised:
            self.run_login(self.browser_hits("/callback?error=access_denied&state={state}"))
        self.assertIn("access_denied", str(raised.exception))

    def test_token_endpoint_refusal_is_reported_readably(self):
        refusing = FakeTokenServer(400, {"error": "invalid_request", "error_description": "code_verifier not supported"})
        self.addCleanup(refusing.close)
        self.token_server = refusing
        with self.assertRaises(LoginError) as raised:
            self.run_login(self.browser_hits("/callback?code=c&state={state}"))
        self.assertIn("HTTP 400 (invalid_request: code_verifier not supported)", str(raised.exception))
        self.assertEqual(self.stored, [])

    def test_no_callback_times_out(self):
        with self.assertRaises(LoginError) as raised:
            self.run_login(lambda url: None, timeout_s=0.5)
        self.assertIn("no answer", str(raised.exception))

    def test_port_already_taken_is_reported(self):
        blocker = HTTPServer(("127.0.0.1", self.port), BaseHTTPRequestHandler)
        self.addCleanup(blocker.server_close)
        with self.assertRaises(LoginError) as raised:
            self.run_login(lambda url: None)
        self.assertIn(str(self.port), str(raised.exception))

    def test_server_binds_to_loopback_only(self):
        with mock.patch("crepe_daemon.spotify_login.http.server.HTTPServer.__init__", side_effect=OSError(98, "busy")) as init:
            with self.assertRaises(LoginError):
                self.run_login(lambda url: None)
        self.assertEqual(init.call_args.args[0], ("127.0.0.1", self.port))


class CliLoginTest(unittest.TestCase):
    def test_login_without_a_spotify_section_explains_what_is_missing(self):
        import io
        import tempfile
        from contextlib import redirect_stderr
        from pathlib import Path

        from crepe_daemon import main as cli

        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "daemon.toml"
            config.write_text("")
            errors = io.StringIO()
            with redirect_stderr(errors), mock.patch("logging.basicConfig"):
                self.assertEqual(cli.main(["--login", "spotify", "--config", str(config)]), 2)
        self.assertIn("client_id", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
