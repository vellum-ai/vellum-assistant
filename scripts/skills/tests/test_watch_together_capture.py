import importlib.util
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).parents[3]
SCRIPT_PATH = REPO_ROOT / "skills" / "watch-together" / "scripts" / "capture_live.py"
SPEC = importlib.util.spec_from_file_location("capture_live", SCRIPT_PATH)
CAPTURE_LIVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CAPTURE_LIVE)


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


if __name__ == "__main__":
    unittest.main()
