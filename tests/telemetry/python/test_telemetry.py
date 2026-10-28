"""Tests for templates/telemetry/telemetry.py.

Run from the repo root: python3 -m unittest discover -s tests/telemetry/python

Every test runs with a cleared environment, a temp HOME and state directory, no
terminal, and a local HTTP server as the endpoint. Nothing touches the real home
directory or the real endpoint.
"""

import importlib.util
import io
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

SOURCE = Path(__file__).resolve().parents[3] / "templates" / "telemetry" / "telemetry.py"
sys.dont_write_bytecode = True  # keep __pycache__ out of templates/


def load_module():
    spec = importlib.util.spec_from_file_location("devkit_telemetry", SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tm = load_module()
REAL_IS_TTY = tm._is_tty
NOW = datetime(2026, 10, 28, 9, 12, 3, 123456, tzinfo=UTC)
ID = "8b0e6c1a-3f0d-4a51-9a7e-2f1c5d9e4b77"
USER = "annexample"


class Recorder(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.server.requests.append({
            "method": self.command, "path": self.path,
            "headers": dict(self.headers), "body": json.loads(body), "raw": body,
        })
        time.sleep(self.server.delay)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


def start_server(delay=0.0):
    server = ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
    server.daemon_threads = True
    server.requests, server.delay = [], delay
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}/i/v0/e/"


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server, cls.endpoint = start_server()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.server.requests.clear()
        tmp = tempfile.TemporaryDirectory(prefix="devkit-telemetry-")
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        self.home = os.path.join(self.tmp, "home", USER)
        self.state_dir = os.path.join(self.tmp, "state", "demo")  # not created yet
        self.state_file = os.path.join(self.state_dir, "telemetry.json")
        env = {"HOME": self.home, "USER": USER, "PATH": os.environ.get("PATH", ""),
               "NO_PROXY": "*", "no_proxy": "*"}
        self.patch(mock.patch.dict(os.environ, env, clear=True))
        self.tty = self.patch(mock.patch.object(tm, "_is_tty", return_value=False))
        self.stderr = io.StringIO()
        self.patch(mock.patch.object(sys, "stderr", self.stderr))

    def patch(self, patcher):
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def env(self, **values):
        os.environ.update(values)

    def make(self, **kwargs):
        options = {"product": "demo", "version": "1.2.3", "state_dir": self.state_dir,
                   "channel": "homebrew", "features": ("sync", "chats list"),
                   "off_command": "demo telemetry off", "endpoint": self.endpoint}
        options.update(kwargs)
        return tm.create_telemetry(**options)

    def write_state(self, **values):
        state = {"id": ID, "enabled": None, "notice": 1, "installed": False, "daily": {}}
        state.update(values)
        os.makedirs(self.state_dir, exist_ok=True)
        with open(self.state_file, "w", encoding="utf-8") as f:
            json.dump(state, f)

    def read_state(self):
        with open(self.state_file, encoding="utf-8") as f:
            return json.load(f)

    def sent(self):
        tm.flush(5)
        return sorted(r["body"]["event"] for r in self.server.requests)

    def bodies(self):
        tm.flush(5)
        return [r["body"] for r in self.server.requests]


class DecisionTests(Base):
    def test_on_by_default_once_the_notice_is_seen(self):
        self.write_state()
        t = self.make()
        self.assertEqual(t.status(), {"enabled": True, "debug": False, "reason": "default",
                                      "id": ID, "stateFile": self.state_file,
                                      "endpoint": self.endpoint})
        t.started()
        self.assertEqual(self.sent(), ["app_installed", "app_started"])

    def test_do_not_track(self):
        self.write_state()
        for value in ("1", "true", "yes"):
            with self.subTest(value=value):
                self.env(DO_NOT_TRACK=value)
                self.assertEqual(self.make().status()["reason"], "do-not-track")
                self.assertFalse(self.make().status()["enabled"])
        for value in ("", "0", "false", "FALSE"):
            with self.subTest(value=value):
                self.env(DO_NOT_TRACK=value)
                self.assertTrue(self.make().status()["enabled"])

    def test_prefix_variable(self):
        self.write_state()
        for value in ("0", "off", "false", "OFF"):
            with self.subTest(value=value):
                self.env(DEMO_TELEMETRY=value)
                status = self.make().status()
                self.assertEqual((status["enabled"], status["reason"]), (False, "env"))
        for value in ("1", "on", "true", " On "):
            with self.subTest(value=value):
                self.env(DEMO_TELEMETRY=value)
                status = self.make().status()
                self.assertEqual((status["enabled"], status["reason"]), (True, "env"))
        self.env(DEMO_TELEMETRY="maybe")  # unknown values are ignored
        self.assertEqual(self.make().status()["reason"], "default")

    def test_env_prefix_defaults_to_the_product_slug(self):
        self.write_state()
        self.env(MY_TOOL_TELEMETRY="0")
        self.assertEqual(self.make(product="my-tool").status()["reason"], "env")
        self.env(CUSTOM_TELEMETRY="0")
        self.assertEqual(self.make(env_prefix="CUSTOM").status()["reason"], "env")

    def test_prefix_on_wins_over_ci_and_dev_versions_but_not_the_notice(self):
        self.env(DEMO_TELEMETRY="1", CI="true", GITHUB_ACTIONS="true")
        t = self.make(version="0.0.0")
        self.assertEqual(t.status()["reason"], "env")
        self.assertIsNotNone(t.notice_text())
        t.started()
        self.assertEqual(self.sent(), [])
        self.write_state()
        self.make(version="0.0.0").started()
        self.assertEqual(self.sent(), ["app_installed", "app_started"])

    def test_debug_prints_each_event_and_sends_nothing(self):
        self.write_state()
        self.env(DEMO_TELEMETRY="debug", CI="1")
        t = self.make()
        status = t.status()
        self.assertEqual((status["enabled"], status["debug"], status["reason"]),
                         (True, True, "env"))
        t.started()
        t.feature("sync")
        self.assertEqual(self.sent(), [])
        lines = self.stderr.getvalue().splitlines()
        self.assertEqual(len(lines), 3)
        self.assertTrue(all(line.startswith("[telemetry] {") for line in lines))
        events = [json.loads(line.removeprefix("[telemetry] "))["event"] for line in lines]
        self.assertEqual(events, ["app_installed", "app_started", "feature_used"])

    def test_ci_variables(self):
        self.write_state()
        for var in ("CI", *tm.CI_VARS):
            with self.subTest(var=var), mock.patch.dict(os.environ, {var: "1"}):
                self.assertEqual(self.make().status()["reason"], "ci")
        for value in ("false", "False", "", " ", " false "):
            with self.subTest(CI=value), mock.patch.dict(os.environ, {"CI": value}):
                self.assertEqual(self.make().status()["reason"], "default")
        blank = dict.fromkeys(tm.CI_VARS, " ")
        with mock.patch.dict(os.environ, blank):  # blank values count as unset
            self.assertEqual(self.make().status()["reason"], "default")

    def test_test_runs(self):
        self.write_state()
        for var in tm.TEST_VARS:
            with self.subTest(var=var), mock.patch.dict(os.environ, {var: "x"}):
                self.assertEqual(self.make().status()["reason"], "test")

    def test_development_versions(self):
        self.write_state()
        for version in ("", None, "dev", "0.0.0", "1.4.0-dev.2", "2.0.0-DEV", "devel",
                        "(devel)", "v0.0.0"):
            with self.subTest(version=version):
                self.assertEqual(self.make(version=version).status()["reason"],
                                 "dev-version")
        for version in ("1.4.0", "v1.4.0", "1.4.0-rc.1"):
            self.assertEqual(self.make(version=version).status()["reason"], "default")

    def test_enabled_in_the_state_file(self):
        self.write_state(enabled=False)
        t = self.make()
        self.assertEqual((t.status()["enabled"], t.status()["reason"]), (False, "state"))
        t.started()
        self.assertEqual(self.sent(), [])
        self.write_state(enabled=True)
        self.assertEqual((t.status()["enabled"], t.status()["reason"]), (True, "state"))

    def test_precedence(self):
        self.write_state(enabled=True)
        cases = [
            ({"DEMO_TELEMETRY": "1"}, {"endpoint": ""}, "no-endpoint"),
            ({"DO_NOT_TRACK": "1", "DEMO_TELEMETRY": "1"}, {}, "do-not-track"),
            ({"DEMO_TELEMETRY": "0", "CI": "1"}, {}, "env"),
            ({"CI": "1", "PYTEST_CURRENT_TEST": "x"}, {"version": "dev"}, "ci"),
            ({"PYTEST_CURRENT_TEST": "x"}, {"version": "dev"}, "test"),
            ({}, {"version": "dev"}, "dev-version"),
            ({}, {}, "state"),
        ]
        for env, options, reason in cases:
            with self.subTest(reason=reason), mock.patch.dict(os.environ, env):
                self.assertEqual(self.make(**options).status()["reason"], reason)
        self.assertEqual(self.make(endpoint="").status()["endpoint"], "")

    def test_off_writes_nothing_and_opens_no_connection(self):
        self.tty.return_value = True
        self.env(DO_NOT_TRACK="1", CLAUDECODE="1")
        with mock.patch("urllib.request.urlopen") as urlopen:
            t = self.make()
            self.assertFalse(t.show_notice())
            self.assertIsNone(t.notice_text())
            t.mark_notice_seen()
            t.started()
            t.feature("sync")
            t.error(ValueError("x"))
            t.status()
            t.flush()
        urlopen.assert_not_called()
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "state")))
        self.assertEqual(self.stderr.getvalue(), "")


class NoticeTests(Base):
    def expected_notice(self, off="demo telemetry off"):
        return ("demo shares usage stats with its author: how often it runs, which "
                "features are used, errors, version and OS, tied to a random install "
                "ID. It never sends your files, arguments or account names. Nothing "
                f"has been sent yet. Turn it off with `{off}` or `DO_NOT_TRACK=1`. "
                "Details: https://usage.sergeybaus.com")

    def test_nothing_is_sent_before_the_notice(self):
        t = self.make()
        t.started()
        t.feature("sync")
        t.error(ValueError("x"))
        self.assertEqual(self.sent(), [])
        self.assertFalse(os.path.exists(self.state_dir))

    def test_show_notice_needs_a_terminal_or_an_agent(self):
        stream = io.StringIO()
        self.assertFalse(self.make().show_notice(stream))
        self.assertEqual(stream.getvalue(), "")
        self.assertFalse(os.path.exists(self.state_dir))

    def test_the_run_that_shows_the_notice_sends_nothing(self):
        self.tty.return_value = True
        t = self.make()
        stream = io.StringIO()
        self.assertTrue(t.show_notice(stream))
        self.assertEqual(stream.getvalue(), self.expected_notice() + "\n")
        state = self.read_state()
        self.assertEqual(state["notice"], 1)
        self.assertEqual(uuid.UUID(state["id"]).version, 4)
        t.started()
        t.feature("sync")
        self.assertEqual(self.sent(), [])
        self.assertFalse(t.show_notice(stream))  # once
        nxt = self.make()
        self.assertFalse(nxt.show_notice(stream))
        nxt.started()
        self.assertEqual(self.sent(), ["app_installed", "app_started"])
        self.assertEqual({b["distinct_id"] for b in self.bodies()}, {state["id"]})

    def test_show_notice_under_an_agent_and_default_stream(self):
        self.env(CLAUDECODE="1")
        self.assertTrue(self.make().show_notice())
        self.assertEqual(self.stderr.getvalue(), self.expected_notice() + "\n")

    def test_notice_text_for_apps_and_plugins(self):
        self.assertEqual(self.make().notice_text(), self.expected_notice())
        self.assertEqual(self.make(off_command=None).notice_text(), self.expected_notice())
        self.assertEqual(self.make(off_command="/demo off").notice_text(),
                         self.expected_notice(off="/demo off"))
        self.write_state()
        self.assertIsNone(self.make().notice_text())

    def test_mark_notice_seen(self):
        t = self.make()
        t.mark_notice_seen()
        t.started()
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.read_state()["notice"], 1)
        nxt = self.make()
        nxt.mark_notice_seen()  # already seen: does not silence this run
        nxt.started()
        self.assertEqual(self.sent(), ["app_installed", "app_started"])

    def test_an_older_notice_version_blocks_sending(self):
        self.write_state(notice=0)
        t = self.make()
        t.started()
        self.assertEqual(self.sent(), [])
        self.assertIsNotNone(t.notice_text())

    def test_unwritable_state_directory_means_silence(self):
        Path(self.tmp, "state").write_text("a file, not a directory")
        self.tty.return_value = True
        t = self.make()
        stream = io.StringIO()
        self.assertFalse(t.show_notice(stream))
        self.assertEqual(stream.getvalue(), "")
        t.started()
        self.assertEqual(self.sent(), [])


class EventTests(Base):
    def test_app_installed_is_sent_once(self):
        self.write_state()
        self.make(mode="interactive").started()
        self.assertEqual(self.sent(), ["app_installed", "app_started"])
        self.assertTrue(self.read_state()["installed"])
        self.server.requests.clear()
        self.make(mode="interactive").started()
        self.assertEqual(self.sent(), ["app_started"])

    def test_app_installed_precedes_the_first_event_of_any_kind(self):
        self.write_state()
        self.make().feature("sync")
        self.assertEqual(self.sent(), ["app_installed", "feature_used"])

    def test_features_outside_the_list_become_other(self):
        self.write_state(installed=True)
        t = self.make(mode="interactive")
        for name in ("sync", "chats list", "rm -rf ~/secret", "Sync", None, 42):
            t.feature(name)
        features = [b["properties"]["feature"] for b in self.bodies()]
        self.assertEqual(sorted(features),
                         sorted(["sync", "chats list", "other", "other", "other", "other"]))

    def test_daily_throttling_in_scheduled_daemon_plugin_and_script_modes(self):
        now = self.patch(mock.patch.object(tm, "_now", return_value=NOW))
        for mode in ("scheduled", "daemon", "plugin", "script"):
            with self.subTest(mode=mode):
                now.return_value = NOW
                self.server.requests.clear()
                self.write_state(installed=True,
                                 daily={"app_started": "2026-10-20", "old": "2026-10-01"})
                t = self.make(mode=mode)
                for _ in range(2):
                    t.started()
                    t.feature("sync")
                    t.feature("unknown one")
                    t.feature("unknown two")
                    t.error(ValueError("a"))
                    t.error(KeyError("b"))
                self.make(mode=mode).started()
                keys = sorted((b["event"], b["properties"].get("feature")
                               or b["properties"].get("error_type")) for b in self.bodies())
                self.assertEqual(keys, [("app_started", None),
                                        ("error_occurred", "KeyError"),
                                        ("error_occurred", "ValueError"),
                                        ("feature_used", "other"),
                                        ("feature_used", "sync")])
                self.assertEqual(self.read_state()["daily"], {
                    "app_started": "2026-10-28", "feature_used:sync": "2026-10-28",
                    "feature_used:other": "2026-10-28",
                    "error_occurred:ValueError": "2026-10-28",
                    "error_occurred:KeyError": "2026-10-28"})
                now.return_value = NOW + timedelta(days=1)
                self.server.requests.clear()
                t.started()
                self.assertEqual(self.sent(), ["app_started"])
                self.assertEqual(self.read_state()["daily"], {"app_started": "2026-10-29"})

    def test_a_run_detected_as_a_script_is_throttled_too(self):
        self.patch(mock.patch.object(tm, "_now", return_value=NOW))
        self.write_state(installed=True)
        self.make().started()  # no mode, no agent, no terminal
        self.make().started()
        self.assertEqual(self.sent(), ["app_started"])
        self.assertEqual(self.read_state()["daily"], {"app_started": "2026-10-28"})

    def test_other_modes_send_every_event(self):
        self.write_state(installed=True)
        for mode in ("interactive", "agent", "app", "server"):
            with self.subTest(mode=mode):
                self.server.requests.clear()
                t = self.make(mode=mode)
                t.started()
                t.started()
                t.feature("sync")
                t.feature("sync")
                self.assertEqual(self.sent(), ["app_started"] * 2 + ["feature_used"] * 2)
                self.assertEqual(self.read_state()["daily"], {})


class ErrorTests(Base):
    def test_scrubs_home_and_user_name(self):
        text = f"cannot open {self.home}/notes/x.txt as {USER} ({USER.upper()})"
        self.assertEqual(tm._scrub(text, self.home, USER),
                         "cannot open ~/notes/x.txt as <user> (<user>)")

    def test_scrubs_windows_paths(self):
        home = "C:\\Users\\example"
        text = "C:\\Users\\Example\\AppData\\x and C:/Users/example/y failed for example"
        self.assertEqual(tm._scrub(text, home, "example"),
                         "~\\AppData\\x and ~/y failed for <user>")

    def test_scrubbing_rules_shared_with_the_other_clients(self):
        cases = [
            ("/Users/Ann", ("ann",), "read /users/ann/x and /Users/annabel/y as ANN", # privacy-scan:allow
             "read ~/x and /Users/annabel/y as <user>"), # privacy-scan:allow
            ("C:\\Users\\ann", ("ann",), "C:\\Users\\Ann\\a and C:/Users/ann/b", # privacy-scan:allow
             "~\\a and ~/b"),
            ("/home/user", ("user", "user"), "user wrote to /home/user/z",
             "<user> wrote to ~/z"),
            ("/home/annexample", ("ann", "annexample"), "ann and annexample annotate",
             "<user> and <user> annotate"),
            ("/", ("a",), " a / b ", "a / b"),
        ]
        for home, names, text, want in cases:
            with self.subTest(text=text):
                self.assertEqual(tm._scrub(text, home, *names), want)

    def test_user_names_come_from_the_environment_and_the_home_path(self):
        self.env(LOGNAME="annlog", USERNAME="annwin")
        home, *names = tm._home_and_names()
        self.assertEqual((home, names), (self.home, [USER, "annlog", "annwin", USER]))

    def test_user_name_is_replaced_as_a_whole_word(self):
        self.assertEqual(tm._scrub("ann wrote an annotation", "", "ann"),
                         "<user> wrote an annotation")

    def test_message_is_cut_to_300_characters(self):
        self.assertEqual(len(tm._scrub("x" * 5000, self.home, USER)), 300)

    def test_error_from_an_exception(self):
        self.write_state(installed=True)
        t = self.make()
        try:
            with open(os.path.join(self.home, "missing", USER + ".txt"), encoding="utf-8"):
                pass
        except OSError as exc:
            t.error(exc)
        t.error(ValueError("y" * 400))
        first, second = self.bodies()
        if first["properties"]["error_type"] != "FileNotFoundError":
            first, second = second, first
        self.assertEqual(first["properties"]["error_type"], "FileNotFoundError")
        self.assertEqual(first["properties"]["error_message"],
                         "[Errno 2] No such file or directory: '~/missing/<user>.txt'")
        self.assertEqual(second["properties"]["error_message"], "y" * 300)

    def test_error_type_alone_and_explicit_message(self):
        self.write_state(installed=True)
        t = self.make()
        t.error("FloodWait")
        t.error(ValueError, "bad value")
        t.error(KeyError("chat name"), message="")  # user content: type only
        props = sorted((b["properties"] for b in self.bodies()),
                       key=lambda p: p["error_type"])
        self.assertEqual([(p["error_type"], p.get("error_message")) for p in props],
                         [("FloodWait", None), ("KeyError", None),
                          ("ValueError", "bad value")])


class StateTests(Base):
    def test_writes_are_atomic(self):
        self.tty.return_value = True
        with mock.patch.object(tm.os, "replace", wraps=os.replace) as replace:
            self.assertTrue(self.make().show_notice(io.StringIO()))
        source, target = replace.call_args.args
        self.assertEqual(target, self.state_file)
        self.assertEqual(os.path.dirname(source), self.state_dir)
        self.assertEqual(os.listdir(self.state_dir), ["telemetry.json"])
        self.assertEqual(list(self.read_state()), ["id", "enabled", "notice", "installed",
                                                   "daily"])
        # The same bytes the TypeScript and Go clients write.
        state_id = self.read_state()["id"]
        self.assertEqual(Path(self.state_file).read_text(encoding="utf-8"),
                         f'{{"id":"{state_id}","enabled":null,"notice":1,'
                         '"installed":false,"daily":{}}\n')

    def test_a_failed_write_leaves_no_temp_file(self):
        self.tty.return_value = True
        with mock.patch.object(tm.os, "replace", side_effect=OSError("disk full")):
            self.assertFalse(self.make().show_notice(io.StringIO()))
        self.assertEqual(os.listdir(self.state_dir), [])

    def test_a_corrupt_state_file_is_treated_as_empty(self):
        os.makedirs(self.state_dir)
        Path(self.state_file).write_text("{not json")
        t = self.make()
        self.assertEqual(t.status()["id"], None)
        t.started()
        self.assertEqual(self.sent(), [])
        self.tty.return_value = True
        self.assertTrue(self.make().show_notice(io.StringIO()))
        self.assertEqual(self.read_state()["notice"], 1)

    def test_off_deletes_the_id_and_the_counters(self):
        self.write_state(installed=True, daily={"app_started": "2026-10-28"})
        t = self.make()
        self.assertTrue(t.set_enabled(False))
        self.assertEqual(self.read_state(), {"id": None, "enabled": False, "notice": 1,
                                             "installed": False, "daily": {}})
        t.started()
        self.assertEqual(self.sent(), [])
        self.assertEqual(t.status()["reason"], "state")

    def test_on_marks_the_notice_seen_and_creates_an_id(self):
        t = self.make()
        self.assertTrue(t.set_enabled(True))
        state = self.read_state()
        self.assertEqual((state["enabled"], state["notice"]), (True, 1))
        self.assertEqual(uuid.UUID(state["id"]).version, 4)
        t.started()  # an explicit opt-in is not a notice run
        self.assertEqual(self.sent(), ["app_installed", "app_started"])

    def test_env_override_after_off_sends_under_a_new_id(self):
        self.write_state(installed=True)
        self.make().set_enabled(False)
        self.tty.return_value = True
        self.env(DEMO_TELEMETRY="1")
        t = self.make()
        self.assertFalse(t.show_notice(io.StringIO()))  # seen before off
        t.started()
        ids = {b["distinct_id"] for b in self.bodies()}
        self.assertEqual(self.sent(), ["app_installed", "app_started"])
        self.assertEqual(ids, {self.read_state()["id"]})
        self.assertNotIn(ID, ids)

    def test_off_in_another_process_stops_a_running_client(self):
        self.write_state(installed=True)
        daemon = self.make(mode="daemon")
        self.make().set_enabled(False)
        daemon.started()
        self.assertEqual(self.sent(), [])


class DetectionTests(Base):
    def test_agents(self):
        cases = [
            ({"AI_AGENT": "Claude_Code"}, "claude"),
            ({"AI_AGENT": "opencode", "CLAUDECODE": "1"}, "opencode"),
            ({"CLAUDECODE": "1", "CODEX_SANDBOX": "seatbelt"}, "claude-code"),
            ({"CODEX_SANDBOX": "seatbelt"}, "codex"),
            ({"CODEX_THREAD_ID": "t"}, "codex"),
            ({"CURSOR_AGENT": "1"}, "cursor"),
            ({"GEMINI_CLI": "1"}, "gemini"),
            ({"AI_AGENT": "", "CLAUDECODE": ""}, None),
        ]
        for env, agent in cases:
            with self.subTest(env=env), mock.patch.dict(os.environ, env):
                self.assertEqual(tm._agent(), agent)

    def test_modes(self):
        self.assertEqual(self.make().mode, "script")
        self.assertEqual(self.make(mode="scheduled").mode, "scheduled")
        self.tty.return_value = True
        self.assertEqual(self.make().mode, "interactive")
        self.env(CURSOR_AGENT="1")
        self.assertEqual(self.make().mode, "agent")
        self.assertEqual(self.make(mode="daemon").mode, "daemon")

    def test_missing_or_broken_streams(self):
        class Broken:
            def isatty(self):
                raise ValueError("I/O operation on closed file")

        self.assertFalse(REAL_IS_TTY(None))
        self.assertFalse(REAL_IS_TTY(Broken()))
        self.tty.side_effect = REAL_IS_TTY
        self.env(DEMO_TELEMETRY="debug")
        with mock.patch.object(sys, "stdin", None), mock.patch.object(sys, "stderr", None):
            t = self.make()
            self.assertEqual(t.mode, "script")
            self.assertFalse(t.show_notice())
            t.started()  # debug output has nowhere to go: no crash


class WireTests(Base):
    def test_exact_request(self):
        self.write_state(installed=True)
        self.env(CLAUDECODE="1")
        self.patch(mock.patch.object(tm, "_now", return_value=NOW))
        self.make(mode="app").feature("chats list")
        tm.flush(5)
        [request] = self.server.requests
        self.assertEqual((request["method"], request["path"]), ("POST", "/i/v0/e/"))
        self.assertEqual(request["headers"]["Content-Type"], "application/json")
        self.assertEqual(request["headers"]["User-Agent"], "devkit-telemetry/1 (demo/1.2.3)")
        system = platform.system()
        if system == "Darwin":
            os_version = platform.mac_ver()[0]
        elif system == "Windows":
            os_version = platform.version()
        else:
            try:
                os_version = platform.freedesktop_os_release().get("VERSION_ID", "")
            except OSError:
                os_version = ""
            os_version = os_version or platform.release()
        machine = platform.machine().lower()
        names = {"Darwin": "macOS", "Windows": "Windows", "Linux": "Linux"}
        properties = {
            "$process_person_profile": False,
            "$lib": "devkit-telemetry",
            "$lib_version": "1",
            "product": "demo",
            "$app_version": "1.2.3",
            "$os": names.get(system, system.lower()),
            "$os_version": os_version,
            "arch": {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64"}.get(
                machine, machine),
            "runtime": f"python {platform.python_version()}",
            "channel": "homebrew",
            "mode": "app",
            "agent": "claude-code",
            "feature": "chats list",
        }
        self.assertEqual(request["body"], {
            "api_key": "phc_np7sxHvzFH1HDTlQdMaqRDrpOVZ0xytnSDxyCMBwNO9",  # gitleaks:allow
            "event": "feature_used",
            "distinct_id": ID,
            "timestamp": "2026-10-28T09:12:03.123Z",
            "properties": properties,
        })
        self.assertEqual(list(request["body"]["properties"]), list(properties))
        self.assertIn(properties["$os"], ("macOS", "Windows", "Linux"))
        compact = json.dumps(request["body"], ensure_ascii=False, separators=(",", ":"))
        self.assertEqual(request["raw"], compact.encode())

    def test_default_endpoint_constant(self):
        self.assertEqual(tm.ENDPOINT, "https://usage.sergeybaus.com/i/v0/e/")
        self.assertEqual(self.make(endpoint=None).status()["endpoint"], tm.ENDPOINT)

    def test_capture_sends_one_event_without_state(self):
        self.patch(mock.patch.object(tm, "_now", return_value=NOW))
        tm.capture("page_viewed", {"page": "home"}, "visitor-1", product="site",
                   version="2.0.0", channel="web", mode="server", endpoint=self.endpoint)
        tm.flush(5)
        [request] = self.server.requests
        self.assertEqual(request["headers"]["User-Agent"], "devkit-telemetry/1 (site/2.0.0)")
        self.assertEqual(request["body"], {
            "api_key": "phc_np7sxHvzFH1HDTlQdMaqRDrpOVZ0xytnSDxyCMBwNO9",  # gitleaks:allow
            "event": "page_viewed",
            "distinct_id": "visitor-1",
            "timestamp": "2026-10-28T09:12:03.123Z",
            "properties": {"$process_person_profile": False, "$lib": "devkit-telemetry",
                           "$lib_version": "1", "product": "site",
                           "$app_version": "2.0.0", **tm._system(), "channel": "web",
                           "mode": "server", "page": "home"},
        })
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "state")))
        self.server.requests.clear()
        tm.capture("app_started", {}, "", product="site", version="2.0.0",
                   endpoint=self.endpoint)
        [body] = self.bodies()
        self.assertEqual(uuid.UUID(body["distinct_id"]).version, 4)
        self.assertNotIn("channel", body["properties"])
        self.assertEqual(body["properties"]["mode"], "script")

    def test_capture_follows_the_environment_rules(self):
        site = {"product": "site", "version": "2.0.0", "endpoint": self.endpoint}
        with mock.patch.dict(os.environ, {"DO_NOT_TRACK": "1"}):
            tm.capture("page_viewed", {}, "v", **site)
        with mock.patch.dict(os.environ, {"CI": "true"}):
            tm.capture("page_viewed", {}, "v", **site)
        with mock.patch.dict(os.environ, {"SITE_TELEMETRY": "off"}):
            tm.capture("page_viewed", {}, "v", **site)
        tm.capture("page_viewed", {}, "v", **{**site, "version": ""})
        tm.capture("page_viewed", {}, "v", **{**site, "endpoint": ""})
        tm.capture("", {}, "v", **site)
        self.assertEqual(self.sent(), [])
        with mock.patch.dict(os.environ, {"CUSTOM_TELEMETRY": "debug"}):
            tm.capture("page_viewed", {}, "v", **site, env_prefix="CUSTOM")
        self.assertEqual(self.sent(), [])
        self.assertTrue(self.stderr.getvalue().startswith("[telemetry] {"))

    def test_network_failures_are_silent(self):
        self.write_state()
        closed = socket_port()
        t = self.make(endpoint=f"http://127.0.0.1:{closed}/i/v0/e/")
        t.started()
        t.flush(5)
        self.make(endpoint="not a url").started()
        tm.capture("x", {}, "id", product="demo", version="1.0.0", endpoint="http://[::bad")
        tm.capture("x", {}, "id")  # missing product and version: swallowed
        tm.flush(5)
        self.assertEqual(self.stderr.getvalue(), "")

    def test_flush_waits_only_for_requests_in_flight(self):
        started = time.monotonic()
        tm.flush(2)
        self.assertLess(time.monotonic() - started, 0.5)
        slow, endpoint = start_server(delay=1.5)
        self.addCleanup(slow.server_close)
        self.addCleanup(slow.shutdown)
        self.write_state(installed=True)
        t = self.make(endpoint=endpoint)
        began = time.monotonic()
        t.started()
        self.assertLess(time.monotonic() - began, 0.5)  # sending never blocks
        began = time.monotonic()
        t.flush(0.2)
        self.assertLess(time.monotonic() - began, 1.0)
        t.flush(5)
        self.assertEqual(len(slow.requests), 1)

    def test_flush_at_exit_is_opt_in(self):
        with mock.patch.object(tm.atexit, "register") as register:
            t = self.make()
            register.assert_not_called()
            t.flush_at_exit(1.5)
        register.assert_called_once_with(tm.flush, 1.5)

    def test_bad_arguments_never_raise(self):
        t = tm.create_telemetry(product=None, version=None, state_dir=None, channel=None)
        self.assertFalse(t.show_notice())
        t.mark_notice_seen()
        t.started()
        t.feature(object())
        t.error(None)
        t.set_enabled(True)
        t.flush()
        self.assertIsInstance(t.status(), dict)
        self.assertEqual(self.stderr.getvalue(), "")

    def test_an_empty_state_dir_is_not_the_current_directory(self):
        self.addCleanup(os.chdir, os.getcwd())
        os.chdir(self.tmp)
        self.tty.return_value = True
        t = self.make(state_dir="")
        self.assertFalse(t.show_notice(io.StringIO()))
        t.set_enabled(True)
        t.started()
        self.assertEqual(os.listdir(self.tmp), [])
        self.assertEqual(self.sent(), [])


class ModuleTests(unittest.TestCase):
    def test_import_has_no_side_effects(self):
        code = (
            "import atexit, importlib.util, socket, sys, threading\n"
            "def no_network(*a, **k): raise AssertionError('network at import')\n"
            "socket.socket.connect = no_network\n"
            "threads, hooks = threading.active_count(), atexit._ncallbacks()\n"
            "spec = importlib.util.spec_from_file_location('t', sys.argv[1])\n"
            "spec.loader.exec_module(importlib.util.module_from_spec(spec))\n"
            "assert threading.active_count() == threads, 'thread at import'\n"
            "assert atexit._ncallbacks() == hooks, 'atexit at import'\n"
            "print('ok')\n"
        )
        result = subprocess.run([sys.executable, "-I", "-B", "-c", code, str(SOURCE)],
                                capture_output=True, text=True, timeout=30,
                                env={"PATH": os.environ.get("PATH", "")}, check=False)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "ok\n", ""))

    def test_template_is_marked_and_has_no_placeholders(self):
        text = SOURCE.read_text(encoding="utf-8")
        self.assertIn("managed by devkit", text.splitlines()[0])
        self.assertIsNone(re.search(r"\{\{\s*[a-z_]", text))


def socket_port():
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


if __name__ == "__main__":
    unittest.main()
