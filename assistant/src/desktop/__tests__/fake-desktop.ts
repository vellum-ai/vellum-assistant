import { sleep } from "../../util/retry.js";
import {
  type DesktopChild,
  type DesktopChildRole,
  type DesktopLoss,
  DesktopSessionManager,
  type DesktopSpawnRequest,
} from "../desktop-session-manager.js";

/** A child the test exits by hand. */
class FakeChild implements DesktopChild {
  private static nextPid = 1000;
  readonly pid = FakeChild.nextPid++;
  readonly exited: Promise<number>;
  private settle!: (code: number) => void;

  constructor(
    readonly role: DesktopChildRole,
    readonly request: DesktopSpawnRequest,
  ) {
    this.exited = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  kill(): void {}

  exit(code = 0): void {
    this.settle(code);
  }
}

export const LINGER_MS = 20;
export const KILL_GRACE_MS = 20;

export interface FakeDesktopOptions {
  profileDir: string;
  /** Roles whose spawn throws, to exercise a start that fails partway. */
  failSpawn?: DesktopChildRole[];
  /** Binaries `which` cannot find. */
  missingBinaries?: string[];
  /** Whether a SIGTERM makes the fake child exit on its own. */
  exitOnTerm?: boolean;
  sourceEnv?: NodeJS.ProcessEnv;
}

export function newFakeDesktop(options: FakeDesktopOptions) {
  const spawned: FakeChild[] = [];
  const killed: { child: FakeChild; signal: string }[] = [];
  let vncReady = true;
  let chromiumPath: () => Promise<string> = async () => "/fake/chromium";
  const manager = new DesktopSessionManager({
    spawn: (role, request) => {
      if (options.failSpawn?.includes(role)) {
        throw new Error(`spawn ${role} failed`);
      }
      const child = new FakeChild(role, request);
      spawned.push(child);
      return child;
    },
    which: (binary) =>
      options.missingBinaries?.includes(binary) ? null : `/usr/bin/${binary}`,
    probeVncPort: async () => vncReady,
    resolveChromiumPath: () => chromiumPath(),
    killProcessGroup: (child, signal) => {
      killed.push({ child: child as FakeChild, signal });
      if (options.exitOnTerm) {
        (child as FakeChild).exit(0);
      }
    },
    lingerMs: LINGER_MS,
    readyDeadlineMs: 30,
    killGraceMs: KILL_GRACE_MS,
    profileDir: options.profileDir,
    sourceEnv: options.sourceEnv,
  });
  return {
    manager,
    spawned,
    killed,
    /** Children that got a SIGTERM, in order. */
    terminated: () =>
      killed.filter((k) => k.signal === "SIGTERM").map((k) => k.child),
    setVncReady: (ready: boolean) => {
      vncReady = ready;
    },
    setChromiumPath: (resolve: () => Promise<string>) => {
      chromiumPath = resolve;
    },
    child: (role: DesktopChildRole) =>
      spawned.filter((c) => c.role === role).at(-1)!,
    roles: () => spawned.map((c) => c.role),
    count: (role: DesktopChildRole) =>
      spawned.filter((c) => c.role === role).length,
  };
}

/** Let one awaited step (a path resolution, an exit callback) land. */
export const settle = (): Promise<void> => sleep(0);

export function newViewer() {
  const lost: DesktopLoss[] = [];
  return {
    lost,
    viewer: { onDesktopLost: (loss: DesktopLoss) => lost.push(loss) },
  };
}
