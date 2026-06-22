"""
Unit tests for mock_github_handler.py.

Plain `unittest`, no third-party deps. Runnable as:

    python3 -m unittest evals/src/lib/egress/recording/test_mock_github_handler.py

The Bun test sweep shells out to this via `mock-github-handler.test.ts`
so the Python handler stays covered alongside the TypeScript surface.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest

from mock_github_handler import (
    handle,
    handle_contents_api,
    handle_raw_api,
)


class MockGithubHandlerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="mock-gh-test-")
        # Build a small plugin tree:
        #   <fixtures>/simple-memory/init.ts
        #   <fixtures>/simple-memory/package.json
        #   <fixtures>/simple-memory/hooks/say-hi.ts
        os.makedirs(os.path.join(self.tmpdir, "simple-memory", "hooks"))
        with open(
            os.path.join(self.tmpdir, "simple-memory", "init.ts"), "w"
        ) as fh:
            fh.write("export const init = () => {};\n")
        with open(
            os.path.join(self.tmpdir, "simple-memory", "package.json"), "w"
        ) as fh:
            fh.write('{"name": "simple-memory"}\n')
        with open(
            os.path.join(self.tmpdir, "simple-memory", "hooks", "say-hi.ts"), "w"
        ) as fh:
            fh.write("export default () => 'hi';\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # ---- Contents API: directory listing ----

    def test_directory_listing_returns_github_shaped_array(self) -> None:
        url = (
            "https://api.github.com/repos/vellum-ai/vellum-assistant/"
            "contents/plugins/simple-memory?ref=main"
        )
        result = handle(method="GET", url=url, fixtures_dir=self.tmpdir)
        self.assertIsNotNone(result)
        status, ct, body = result  # type: ignore[misc]
        self.assertEqual(status, 200)
        self.assertEqual(ct, "application/json")
        entries = json.loads(body)
        self.assertIsInstance(entries, list)
        self.assertEqual(
            sorted(e["name"] for e in entries),
            ["hooks", "init.ts", "package.json"],
        )
        for entry in entries:
            self.assertIn(entry["type"], ("file", "dir"))
            if entry["type"] == "dir":
                self.assertIsNone(entry["download_url"])
                self.assertEqual(entry["size"], 0)
            else:
                self.assertTrue(
                    entry["download_url"].startswith(
                        "https://raw.githubusercontent.com/vellum-ai/vellum-assistant/main/"
                    )
                )
                self.assertTrue(
                    entry["path"].startswith("plugins/simple-memory/")
                )

    def test_subdirectory_listing_recurses_with_correct_repo_path(self) -> None:
        url = (
            "https://api.github.com/repos/vellum-ai/vellum-assistant/"
            "contents/plugins/simple-memory/hooks?ref=main"
        )
        result = handle(method="GET", url=url, fixtures_dir=self.tmpdir)
        self.assertIsNotNone(result)
        _, _, body = result  # type: ignore[misc]
        entries = json.loads(body)
        self.assertEqual([e["name"] for e in entries], ["say-hi.ts"])
        self.assertEqual(
            entries[0]["path"], "plugins/simple-memory/hooks/say-hi.ts"
        )

    def test_single_file_returns_object_not_array(self) -> None:
        # GitHub's Contents API returns the entry object (not an
        # array) when the path resolves to a file. The install
        # loader's listDir() treats a non-array response as
        # "not a plugin directory" and returns null.
        url = (
            "https://api.github.com/repos/vellum-ai/vellum-assistant/"
            "contents/plugins/simple-memory/init.ts?ref=main"
        )
        result = handle(method="GET", url=url, fixtures_dir=self.tmpdir)
        self.assertIsNotNone(result)
        status, _, body = result  # type: ignore[misc]
        self.assertEqual(status, 200)
        entry = json.loads(body)
        self.assertIsInstance(entry, dict)
        self.assertEqual(entry["name"], "init.ts")
        self.assertEqual(entry["type"], "file")

    # ---- Raw API: file bytes ----

    def test_raw_file_returns_file_bytes_verbatim(self) -> None:
        url = (
            "https://raw.githubusercontent.com/vellum-ai/vellum-assistant/"
            "main/plugins/simple-memory/init.ts"
        )
        result = handle(method="GET", url=url, fixtures_dir=self.tmpdir)
        self.assertIsNotNone(result)
        status, ct, body = result  # type: ignore[misc]
        self.assertEqual(status, 200)
        self.assertEqual(ct, "application/octet-stream")
        self.assertEqual(body, b"export const init = () => {};\n")

    def test_raw_arbitrary_ref_is_accepted(self) -> None:
        # The mock pins fixtures to the runner's checkout, so any
        # ref the install loader passes is fine — we don't try to
        # honor it. The install loader URL-encodes refs containing
        # slashes (`encodeURIComponent`), so the path-component the
        # regex sees is always a single non-slash segment. Cover
        # plain branch + tag + SHA shapes.
        for ref in ("main", "v1.2.3", "a1b2c3d4e5"):
            url = (
                f"https://raw.githubusercontent.com/vellum-ai/vellum-assistant/"
                f"{ref}/plugins/simple-memory/init.ts"
            )
            result = handle(method="GET", url=url, fixtures_dir=self.tmpdir)
            self.assertIsNotNone(result, ref)
            status, _, _ = result  # type: ignore[misc]
            self.assertEqual(status, 200)

    # ---- 404 paths ----

    def test_missing_plugin_returns_404(self) -> None:
        url = (
            "https://api.github.com/repos/vellum-ai/vellum-assistant/"
            "contents/plugins/does-not-exist?ref=main"
        )
        result = handle(method="GET", url=url, fixtures_dir=self.tmpdir)
        self.assertIsNotNone(result)
        status, _, _ = result  # type: ignore[misc]
        self.assertEqual(status, 404)

    def test_path_outside_plugins_dir_returns_404(self) -> None:
        # The fixtures dir is scoped to plugins/. Even
        # if the runner pointed at the repo root, we'd refuse other
        # repo paths up front so the assistant can't read arbitrary
        # repo files via the mock.
        url = (
            "https://api.github.com/repos/vellum-ai/vellum-assistant/"
            "contents/assistant/Dockerfile?ref=main"
        )
        result = handle(method="GET", url=url, fixtures_dir=self.tmpdir)
        self.assertIsNotNone(result)
        status, _, _ = result  # type: ignore[misc]
        self.assertEqual(status, 404)

    def test_path_escape_is_refused(self) -> None:
        # `..` URI components should never reach a path outside
        # fixtures. The handler either treats the URL as
        # non-matching (skip) or returns 404. Either is safe.
        url = (
            "https://raw.githubusercontent.com/vellum-ai/vellum-assistant/"
            "main/plugins/../../etc/passwd"
        )
        result = handle(method="GET", url=url, fixtures_dir=self.tmpdir)
        if result is not None:
            status, _, _ = result
            self.assertEqual(status, 404)

    # ---- Skip cases (return None) ----

    def test_unrelated_host_is_skipped(self) -> None:
        self.assertIsNone(
            handle(
                method="POST",
                url="https://api.anthropic.com/v1/messages",
                fixtures_dir=self.tmpdir,
            )
        )

    def test_unrelated_repo_is_skipped(self) -> None:
        self.assertIsNone(
            handle(
                method="GET",
                url="https://api.github.com/repos/openai/foo/contents/bar",
                fixtures_dir=self.tmpdir,
            )
        )

    def test_non_get_method_is_skipped(self) -> None:
        url = (
            "https://api.github.com/repos/vellum-ai/vellum-assistant/"
            "contents/plugins/simple-memory"
        )
        # POST/PUT/DELETE on a matching URL still skips — the install
        # loader is read-only and we don't want to invent a write API.
        for method in ("POST", "PUT", "DELETE", "PATCH"):
            self.assertIsNone(
                handle(method=method, url=url, fixtures_dir=self.tmpdir),
                method,
            )

    def test_contents_handler_skips_raw_host(self) -> None:
        # Each handler is dispatchable in isolation; the contents
        # handler must skip raw URLs so a future caller using only
        # one half of the dispatch still gets the right behavior.
        url = (
            "https://raw.githubusercontent.com/vellum-ai/vellum-assistant/"
            "main/plugins/simple-memory/init.ts"
        )
        self.assertIsNone(
            handle_contents_api(
                method="GET", url=url, fixtures_dir=self.tmpdir
            )
        )

    def test_raw_handler_skips_contents_host(self) -> None:
        url = (
            "https://api.github.com/repos/vellum-ai/vellum-assistant/"
            "contents/plugins/simple-memory?ref=main"
        )
        self.assertIsNone(
            handle_raw_api(method="GET", url=url, fixtures_dir=self.tmpdir)
        )


if __name__ == "__main__":
    unittest.main()
