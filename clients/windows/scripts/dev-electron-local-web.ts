import path from "node:path";

const packageDir = path.resolve(import.meta.dir, "..");

export const platformOriginFromDevUrl = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("VELLUM_DEV_URL must use http or https");
  }
  return url.origin;
};

const run = async (
  args: string[],
  env: Record<string, string | undefined>,
): Promise<number> => {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: packageDir,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
};

const main = async (): Promise<void> => {
  const remoteUrl = process.env.VELLUM_DEV_URL;
  if (!remoteUrl) {
    throw new Error(
      "Set VELLUM_DEV_URL to the remote platform URL, for example https://dev-assistant.vellum.ai/assistant",
    );
  }

  const platformOrigin = platformOriginFromDevUrl(remoteUrl);
  const buildExitCode = await run(["run", "build:web"], {
    ...process.env,
    VITE_PLATFORM_MODE: "false",
  });
  if (buildExitCode !== 0) {
    process.exit(buildExitCode);
  }

  process.exit(
    await run(["run", "dev:electron-only"], {
      ...process.env,
      VELLUM_LOCAL_RENDERER: "true",
      VELLUM_PLATFORM_URL: platformOrigin,
      VELLUM_WEB_URL: platformOrigin,
    }),
  );
};

if (import.meta.main) {
  await main();
}
