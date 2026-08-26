import importlib.util
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).parents[3]
SCRIPT_PATH = REPO_ROOT / "skills" / "watch-together" / "scripts" / "capture_live.py"
SPEC = importlib.util.spec_from_file_location("capture_live", SCRIPT_PATH)
CAPTURE_LIVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CAPTURE_LIVE)

WATCH_FILE_PATH = REPO_ROOT / "skills" / "watch-together" / "scripts" / "watch-file.py"
WATCH_SPEC = importlib.util.spec_from_file_location("watch_file", WATCH_FILE_PATH)
WATCH_FILE = importlib.util.module_from_spec(WATCH_SPEC)
WATCH_SPEC.loader.exec_module(WATCH_FILE)
EDITOR = WATCH_FILE.editor


class CaptureCommandTests(unittest.TestCase):
    def setUp(self):
        self.chunks = Path("session/chunks")

    def test_macos_preserves_avfoundation_defaults(self):
        command = CAPTURE_LIVE.build_ffmpeg_command(
            "Darwin", self.chunks, 60, env={}
        )
        self.assertIn("avfoundation", command)
        self.assertIn("2:none", command)
        self.assertIn("-an", command)

    def test_windows_adds_explicit_directshow_audio(self):
        command = CAPTURE_LIVE.build_ffmpeg_command(
            "Windows", self.chunks, 30, audio_device="Stereo Mix", env={}
        )
        self.assertIn("gdigrab", command)
        self.assertIn("desktop", command)
        self.assertIn("dshow", command)
        self.assertIn("audio=Stereo Mix", command)
        self.assertIn("1:a:0", command)

    def test_linux_uses_display_and_pulse_monitor(self):
        command = CAPTURE_LIVE.build_ffmpeg_command(
            "Linux",
            self.chunks,
            60,
            audio_device="default.monitor",
            env={"DISPLAY": ":1"},
        )
        self.assertIn("x11grab", command)
        self.assertIn(":1", command)
        self.assertIn("pulse", command)
        self.assertIn("default.monitor", command)

    def test_linux_requires_an_x11_display(self):
        with self.assertRaisesRegex(ValueError, "requires DISPLAY"):
            CAPTURE_LIVE.build_ffmpeg_command("Linux", self.chunks, 60, env={})


class FakeStdin:
    def __init__(self):
        self.writes = []
        self.closed = False

    def write(self, value):
        self.writes.append(value)

    def flush(self):
        pass

    def close(self):
        self.closed = True


class FakeCapture:
    def __init__(self, wait_results):
        self.stdin = FakeStdin()
        self.wait_results = list(wait_results)
        self.wait_timeouts = []
        self.terminated = False
        self.killed = False

    def poll(self):
        return None

    def wait(self, timeout=None):
        self.wait_timeouts.append(timeout)
        result = self.wait_results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True


class CaptureStopTests(unittest.TestCase):
    def test_requests_ffmpeg_quit_before_termination(self):
        capture = FakeCapture([0])

        CAPTURE_LIVE.stop_capture(capture)

        self.assertEqual(capture.stdin.writes, [b"q\n"])
        self.assertTrue(capture.stdin.closed)
        self.assertFalse(capture.terminated)
        self.assertEqual(capture.wait_timeouts, [10])

    def test_terminates_only_after_graceful_timeout(self):
        timeout = subprocess.TimeoutExpired("ffmpeg", 10)
        capture = FakeCapture([timeout, 0])

        CAPTURE_LIVE.stop_capture(capture)

        self.assertTrue(capture.terminated)
        self.assertFalse(capture.killed)
        self.assertEqual(capture.wait_timeouts, [10, 5])


class FakeClock:
    def __init__(self):
        self.now = 0

    def monotonic(self):
        return self.now

    def sleep(self, duration):
        self.now += duration


class PipeReadTests(unittest.TestCase):
    def test_unresponsive_pipe_read_returns_at_deadline(self):
        clock = FakeClock()
        read_called = False

        def read(_size):
            nonlocal read_called
            read_called = True
            return b""

        result = WATCH_FILE.read_when_available(
            read,
            lambda: 0,
            0.05,
            clock=clock.monotonic,
            sleep=clock.sleep,
        )

        self.assertIsNone(result)
        self.assertFalse(read_called)
        self.assertEqual(clock.now, 0.05)


class WakeInstructionTests(unittest.TestCase):
    def test_rewind_instruction_uses_portable_python_script(self):
        note = EDITOR.rewind_command_note('"example.mp4"')

        self.assertIn("scripts/rewind.py", note)
        self.assertIn("host's Python 3 launcher", note)
        self.assertNotIn("rewind.sh", note)


if __name__ == "__main__":
    unittest.main()
