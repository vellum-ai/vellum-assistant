import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import {
  findDesktopBrowserPid,
  validateDesktopWebSocket,
} from "./desktop-browser-endpoint.js";

test("discovery only accepts the allocated loopback browser endpoint", () => {
  expect(
    validateDesktopWebSocket(
      "ws://127.0.0.1:9222/devtools/browser/abc-123",
      9222,
    ),
  ).toBe("ws://127.0.0.1:9222/devtools/browser/abc-123");
  for (const endpoint of [
    "ws://example.com:9222/devtools/browser/abc",
    "ws://127.0.0.1:9223/devtools/browser/abc",
    "ws://user:password@127.0.0.1:9222/devtools/browser/abc",
    "ws://127.0.0.1:9222/devtools/page/abc",
    "ws://127.0.0.1:9222/devtools/browser/abc?redirect=1",
    "ws://127.0.0.1:9222/devtools/browser/abc#fragment",
    undefined,
  ]) {
    expect(() => validateDesktopWebSocket(endpoint, 9222)).toThrow();
  }
});

test("dock browser discovery validates the profile lock against the live executable and arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-pid-"));
  const executable = join(directory, "chrome");
  const profile = join(directory, "profile");
  const proc = join(directory, "proc");
  const processDir = join(proc, "1234");
  try {
    await mkdir(profile);
    await mkdir(processDir, { recursive: true });
    await writeFile(executable, "test executable");
    await symlink("desktop-1234", join(profile, "SingletonLock"));
    await symlink(await realpath(executable), join(processDir, "exe"));
    const args = [
      executable,
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=9222",
      "--remote-debugging-address=127.0.0.1",
    ];
    const discover = () =>
      findDesktopBrowserPid(executable, profile, 9222, proc);
    await writeFile(join(processDir, "cmdline"), args.join("\0"));
    expect(await discover()).toBe(1234);
    for (const changed of [
      args.map((arg) => arg.replace("port=9222", "port=9223")),
      args.map((arg) => arg.replace(profile, join(directory, "other-profile"))),
      args.map((arg) => arg.replace("address=127.0.0.1", "address=0.0.0.0")),
      [...args, "--type=renderer"],
    ]) {
      await writeFile(join(processDir, "cmdline"), changed.join("\0"));
      expect(await discover()).toBeUndefined();
    }
    await writeFile(join(processDir, "cmdline"), args.join("\0"));
    await rm(join(processDir, "exe"));
    await symlink(join(directory, "other-executable"), join(processDir, "exe"));
    expect(await discover()).toBeUndefined();
    await rm(processDir, { recursive: true });
    expect(await discover()).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
