/**
 * Builds the Rust native helper into `resources/native-helper/<arch>/`.
 * `--check` runs cargo fmt, clippy and test instead of building.
 */

import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { argValue } from "./cli-args";

const linuxRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crateRoot = join(linuxRoot, "native", "linux-helper");
const EXECUTABLE = "vellum-linux-helper";

// One static binary per architecture, each built on a native runner. We do not
// cross-compile: the gnu targets need a matching linker and sysroot.
const TARGETS = {
  arm64: "aarch64-unknown-linux-gnu",
  x64: "x86_64-unknown-linux-gnu",
} as const;

type Arch = keyof typeof TARGETS;

const resolveArch = (requested: string | undefined): Arch => {
  const arch = requested ?? process.env.ELECTRON_TARGET_ARCH ?? process.arch;
  if (!(arch in TARGETS)) {
    throw new Error(`Unsupported architecture: ${arch} (use x64 or arm64)`);
  }
  return arch as Arch;
};

const cargo = (): string =>
  Bun.which("cargo") ?? join(process.env.HOME ?? "", ".cargo", "bin", "cargo");

const run = async (command: string[]): Promise<void> => {
  console.log(`[native-helper] ${command.join(" ")}`);
  const child = Bun.spawn(command, {
    cwd: crateRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) {
    throw new Error(`Command failed: ${command.join(" ")}`);
  }
};

const check = async (): Promise<void> => {
  await run([cargo(), "fmt", "--all", "--check"]);
  await run([cargo(), "clippy", "--all-targets", "--", "-D", "warnings"]);
  await run([cargo(), "test"]);
};

const build = async (arch: Arch): Promise<void> => {
  if (process.platform !== "linux") {
    throw new Error(
      `The native helper builds on Linux only, not ${process.platform}`,
    );
  }
  if (process.arch !== arch) {
    throw new Error(
      `Build ${arch} on a native ${arch} runner; this host is ${process.arch}`,
    );
  }
  const target = TARGETS[arch];
  await run([cargo(), "build", "--release", "--target", target]);
  const outputDir = join(linuxRoot, "resources", "native-helper", arch);
  await mkdir(outputDir, { recursive: true });
  const destination = join(outputDir, EXECUTABLE);
  await copyFile(
    join(crateRoot, "target", target, "release", EXECUTABLE),
    destination,
  );
  await chmod(destination, 0o755);
  console.log(`[native-helper] ${destination}`);
};

const main = async (): Promise<void> => {
  if (process.argv.includes("--check")) {
    await check();
    return;
  }
  await build(resolveArch(argValue("--arch")));
};

if (import.meta.main) {
  await main();
}
