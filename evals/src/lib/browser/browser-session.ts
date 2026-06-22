import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { assertSuccess, type CommandRunner } from "../runtime/command-runner";

/**
 * A single browser interaction the simulator can drive against a loaded
 * app. Elements are targeted by ARIA role + accessible name — the same
 * identifiers `observe` reports — so an action references what the
 * simulator saw rather than a CSS selector or pixel coordinate.
 */
export type BrowserAction =
  | { kind: "click"; role: string; name: string; nth?: number }
  | { kind: "type"; role: string; name: string; text: string; nth?: number }
  | { kind: "press"; key: string }
  | { kind: "scroll"; dx?: number; dy?: number };

/**
 * A snapshot of the loaded page for the simulator to reason over. The
 * accessibility snapshot is the primary observation channel — compact,
 * layout-independent, and expressed in the role + accessible-name terms a
 * `BrowserAction` targets; screenshots stay a separate evidence channel.
 */
export interface BrowserObservation {
  /** The page's current URL. */
  url: string;
  /** ARIA accessibility tree of the page body, as YAML. */
  snapshot: string;
  /** Page console errors and uncaught exceptions seen so far. */
  consoleErrors: string[];
}

export interface LaunchBrowserSessionOptions {
  /** Stable run identifier; names the browser container (`<runId>-browser`). */
  runId: string;
  /**
   * The egress jail's `netnsContainer`. The browser joins its network
   * namespace via `--network container:<netnsContainer>`, so it is born
   * behind the same fail-closed allowlist as the assistant and cannot
   * make unrecorded egress while interacting with untrusted, agent-built
   * pages.
   */
  netnsContainer: string;
  /**
   * Host directory bind-mounted at `/state`. The container writes its CDP
   * endpoint, console-error log, and screenshots here, so the host reads
   * screenshots straight off disk with no `docker cp` round-trip. The
   * caller must ensure the directory exists.
   */
  stateDir: string;
  /** Local image tag. Defaults to `vellum-evals-browser:local`. */
  image?: string;
  /** Build-context directory for the image. Defaults to `./image`. */
  imageDir?: string;
  /** Poll interval while waiting for CDP readiness. Defaults to 100ms. */
  readyPollMs?: number;
  /** Max readiness polls before giving up. Defaults to 100. */
  readyMaxAttempts?: number;
  /** Sleep between readiness polls. Injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_IMAGE = "vellum-evals-browser:local";
const DEFAULT_READY_POLL_MS = 100;
const DEFAULT_READY_MAX_ATTEMPTS = 100;
const DRIVER_PATH = "/opt/browser/driver.mjs";
const STATE_MOUNT = "/state";
const CDP_ENDPOINT_FILENAME = "cdp-endpoint";
const CDP_ENDPOINT_FILE = `${STATE_MOUNT}/${CDP_ENDPOINT_FILENAME}`;

const ObservationSchema = z.object({
  url: z.string(),
  snapshot: z.string(),
  consoleErrors: z.array(z.string()),
});

const ActionResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ error: z.string() }),
]);

/** Deterministic container name keeps cleanup idempotent and debuggable. */
export function browserSessionContainerName(runId: string): string {
  return `${runId}-browser`;
}

function browserDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function defaultImageDir(): string {
  return resolve(browserDir(), "image");
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * A headless Chromium in the egress jail that loads an app and exposes a
 * small, stable verb set for driving it.
 *
 * The container runs a long-lived browser (`image/server.mjs`); each verb
 * is a short-lived `image/driver.mjs` invoked over `docker exec` that
 * attaches to that browser over CDP, so page state persists across verbs.
 * The image builds locally on demand, mirroring the recording egress
 * jail's owner-mode build.
 *
 * Because the browser shares the jail's network namespace, it must be
 * removed (`close()`) before the jail stops — the namespace owner outlives
 * its tenants.
 */
export class BrowserSession {
  private readonly containerName: string;
  private readonly stateDir: string;

  private constructor(
    private readonly runner: CommandRunner,
    options: LaunchBrowserSessionOptions,
  ) {
    this.containerName = browserSessionContainerName(options.runId);
    this.stateDir = resolve(options.stateDir);
  }

  /**
   * Build the image, start the browser container attached to the jail's
   * network namespace, and wait for its CDP endpoint to come up.
   */
  static async launch(
    runner: CommandRunner,
    options: LaunchBrowserSessionOptions,
  ): Promise<BrowserSession> {
    const session = new BrowserSession(runner, options);
    await session.start(options);
    return session;
  }

  private async start(options: LaunchBrowserSessionOptions): Promise<void> {
    const image = options.image ?? DEFAULT_IMAGE;
    const imageDir = options.imageDir ?? defaultImageDir();

    await this.runner
      .run("docker", ["rm", "-f", this.containerName])
      .catch(() => undefined);

    // A reused state directory can still hold the previous boot's endpoint
    // file. Readiness is signalled by that file's presence, so clear it
    // before the container starts or polling could pass against a browser
    // that is no longer listening.
    await this.runner
      .run("rm", ["-f", join(this.stateDir, CDP_ENDPOINT_FILENAME)])
      .catch(() => undefined);

    const build = await this.runner.run("docker", [
      "build",
      "-t",
      image,
      imageDir,
    ]);
    assertSuccess(build, `build browser session image ${image}`);

    const run = await this.runner.run("docker", [
      "run",
      "-d",
      "--name",
      this.containerName,
      "--network",
      `container:${options.netnsContainer}`,
      "--label",
      "evals.vellum.ai/browser-session=1",
      "-v",
      `${this.stateDir}:${STATE_MOUNT}`,
      image,
    ]);
    assertSuccess(run, `start browser session container ${this.containerName}`);

    // The container shares the jail's network namespace, so a started-but-
    // never-ready container must be removed before the error propagates;
    // otherwise it leaks and outlives the jail it depends on.
    try {
      await this.waitForReady(options);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private async waitForReady(
    options: LaunchBrowserSessionOptions,
  ): Promise<void> {
    const pollMs = options.readyPollMs ?? DEFAULT_READY_POLL_MS;
    const maxAttempts = options.readyMaxAttempts ?? DEFAULT_READY_MAX_ATTEMPTS;
    const sleep = options.sleep ?? realSleep;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await this.runner.run("docker", [
        "exec",
        this.containerName,
        "cat",
        CDP_ENDPOINT_FILE,
      ]);
      if (result.exitCode === 0 && result.stdout.trim().length > 0) return;
      await sleep(pollMs);
    }
    throw new Error(
      `browser session ${this.containerName} did not become ready`,
    );
  }

  /** Load a self-contained HTML page, replacing the current document. */
  async load(html: string): Promise<void> {
    await this.execAction({ kind: "load", html });
  }

  /** Observe the loaded page's accessibility tree, URL, and console errors. */
  async observe(): Promise<BrowserObservation> {
    const raw = await this.execAction({ kind: "observe" });
    return ObservationSchema.parse(raw);
  }

  /** Perform one interaction against the loaded page. */
  async act(action: BrowserAction): Promise<void> {
    await this.execAction(action);
  }

  /**
   * Capture a screenshot to `<stateDir>/<name>` and return its host path.
   * The name must be a bare filename so it can't escape the state mount.
   */
  async screenshot(name: string): Promise<string> {
    if (name.length === 0 || name.includes("/")) {
      throw new Error(`screenshot name must be a bare filename: ${name}`);
    }
    await this.execAction({
      kind: "screenshot",
      path: `${STATE_MOUNT}/${name}`,
    });
    return join(this.stateDir, name);
  }

  /**
   * Remove the browser container. Best-effort and idempotent: a failure
   * here must not mask the original error on a teardown path. Call before
   * stopping the jail whose namespace this container shares.
   */
  async close(): Promise<void> {
    await this.runner
      .run("docker", ["rm", "-f", this.containerName])
      .catch(() => undefined);
  }

  private async execAction(action: Record<string, unknown>): Promise<unknown> {
    const result = await this.runner.run(
      "docker",
      ["exec", "-i", this.containerName, "node", DRIVER_PATH],
      { stdin: JSON.stringify(action) },
    );
    assertSuccess(result, `browser action ${String(action.kind)}`);
    const parsed: unknown = JSON.parse(result.stdout);
    const actionResult = ActionResultSchema.safeParse(parsed);
    if (actionResult.success && "error" in actionResult.data) {
      throw new Error(
        `browser action ${String(action.kind)} failed: ${actionResult.data.error}`,
      );
    }
    return parsed;
  }
}
