import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const scriptPath = join(
  import.meta.dir,
  "..",
  "..",
  "docker-kata-apt-shims.sh",
);
const testRoots: string[] = [];

afterEach(() => {
  for (const root of testRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createDataRoot(): string {
  const dataRoot = mkdtempSync(join(tmpdir(), "kata-apt-shims-"));
  testRoots.push(dataRoot);
  for (const dir of [
    "usr/bin",
    "usr/sbin",
    "usr/games",
    "usr/local/bin",
    "usr/local/sbin",
    "var/lib/dpkg",
  ]) {
    mkdirSync(join(dataRoot, dir), { recursive: true });
  }
  writeFileSync(join(dataRoot, "var/lib/dpkg/status"), "unchanged\n");
  return dataRoot;
}

function refreshShims(dataRoot: string, pathPrefix?: string): void {
  execFileSync("/bin/sh", [scriptPath], {
    env: {
      ...process.env,
      PATH: pathPrefix
        ? `${pathPrefix}:${process.env.PATH ?? ""}`
        : process.env.PATH,
      VELLUM_APT_DATA_ROOT: dataRoot,
    },
  });
}

describe("docker-kata-apt-shims", () => {
  test.skipIf(process.platform !== "linux")(
    "refreshes a shim when a same-version reinstall retargets its trampoline",
    () => {
      const dataRoot = createDataRoot();

      const suffix = basename(dataRoot);
      const firstTarget = `/vellum-apt-shim-test/${suffix}-1`;
      const secondTarget = `/vellum-apt-shim-test/${suffix}-2`;
      const source = join(dataRoot, "usr/bin/example-tool");
      const shim = join(dataRoot, ".host-shims/example-tool");

      for (const target of [firstTarget, secondTarget]) {
        const chrootTarget = `${dataRoot}${target}`;
        mkdirSync(join(chrootTarget, ".."), { recursive: true });
        writeExecutable(chrootTarget, "#!/bin/sh\nexit 0\n");
      }

      writeExecutable(source, `#!/bin/sh\nexec ${firstTarget} "$@"\n`);
      refreshShims(dataRoot);
      expect(readFileSync(shim, "utf8")).toContain(firstTarget);

      writeExecutable(source, `#!/bin/sh\nexec ${secondTarget} "$@"\n`);
      const fakeBin = join(dataRoot, "fake-bin");
      const failedOnce = join(dataRoot, "mv-failed-once");
      mkdirSync(fakeBin);
      writeExecutable(
        join(fakeBin, "mv"),
        `#!/bin/sh
if [ ! -e "${failedOnce}" ]; then
  touch "${failedOnce}"
  exit 91
fi
[ -f "$3" ] || exit 92
exec /bin/mv "$@"
`,
      );

      expect(() => refreshShims(dataRoot, fakeBin)).toThrow();
      expect(readFileSync(shim, "utf8")).toContain(firstTarget);
      refreshShims(dataRoot, fakeBin);

      const refreshedShim = readFileSync(shim, "utf8");
      expect(refreshedShim).toContain(secondTarget);
      expect(refreshedShim).not.toContain(firstTarget);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "ignores non-executable entries and refreshes when they become runnable",
    () => {
      const dataRoot = createDataRoot();
      const suffix = basename(dataRoot);
      const target = `/vellum-apt-shim-test/${suffix}`;
      const chrootTarget = `${dataRoot}${target}`;
      const lowerSource = join(dataRoot, "usr/sbin/example-tool");
      const higherSource = join(dataRoot, "usr/local/bin/example-tool");
      const shim = join(dataRoot, ".host-shims/example-tool");

      mkdirSync(join(chrootTarget, ".."), { recursive: true });
      writeExecutable(chrootTarget, "#!/bin/sh\nexit 0\n");
      writeExecutable(lowerSource, `#!/bin/sh\nexec ${target} "$@"\n`);
      writeFileSync(higherSource, "#!/bin/sh\nexit 0\n", { mode: 0o644 });

      refreshShims(dataRoot);
      expect(readFileSync(shim, "utf8")).toContain(target);

      chmodSync(higherSource, 0o755);
      refreshShims(dataRoot);
      expect(existsSync(shim)).toBe(false);
    },
  );
});
