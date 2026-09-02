import { execFileSync } from "node:child_process";
import {
  chmodSync,
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

describe("docker-kata-apt-shims", () => {
  test.skipIf(process.platform !== "linux")(
    "refreshes a shim when a same-version reinstall retargets its trampoline",
    () => {
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
      execFileSync("/bin/sh", [scriptPath], {
        env: { ...process.env, VELLUM_APT_DATA_ROOT: dataRoot },
      });
      expect(readFileSync(shim, "utf8")).toContain(firstTarget);

      writeExecutable(source, `#!/bin/sh\nexec ${secondTarget} "$@"\n`);
      execFileSync("/bin/sh", [scriptPath], {
        env: { ...process.env, VELLUM_APT_DATA_ROOT: dataRoot },
      });

      const refreshedShim = readFileSync(shim, "utf8");
      expect(refreshedShim).toContain(secondTarget);
      expect(refreshedShim).not.toContain(firstTarget);
    },
  );
});
