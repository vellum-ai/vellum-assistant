import { describe, expect, mock, test } from "bun:test";

import {
  desktopChromePath,
  desktopDependenciesReady,
  DesktopDependencyInstaller,
  type DesktopSetupStatus,
} from "./desktop-dependencies.js";

const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

function setup() {
  let ready = false;
  let supported = true;
  let finish!: () => void;
  let fail!: (err: Error) => void;
  let progress!: (stage: NonNullable<DesktopSetupStatus["stage"]>) => void;
  const notify = mock(async () => {});
  const install = mock((onStage: typeof progress) => {
    progress = onStage;
    return new Promise<void>((resolve, reject) => {
      finish = () => {
        ready = true;
        resolve();
      };
      fail = reject;
    });
  });
  const installer = new DesktopDependencyInstaller({
    supported: () => supported,
    ready: () => ready,
    install,
    notify,
  });
  return {
    installer,
    install,
    notify,
    finish: () => finish(),
    fail: () => fail(new Error("download failed")),
    progress: () => progress("chrome"),
    restoreComponents: () => {
      ready = true;
    },
    removeComponents: () => {
      ready = false;
    },
    unsupported: () => {
      supported = false;
    },
  };
}

describe("desktop dependency installation", () => {
  test("status is read only and repeated starts share one install", async () => {
    const f = setup();
    expect(f.installer.getStatus().state).toBe("required");
    expect(f.install).not.toHaveBeenCalled();
    expect(f.installer.start().state).toBe("installing");
    f.installer.start();
    await flush();
    expect(f.install).toHaveBeenCalledTimes(1);
    f.progress();
    expect(f.installer.getStatus()).toEqual({
      state: "installing",
      stage: "chrome",
    });
    f.finish();
    await flush();
    expect(f.installer.getStatus().state).toBe("ready");
    f.installer.start();
    expect(f.install).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledTimes(3);
    f.removeComponents();
    expect(f.installer.getStatus().state).toBe("required");
  });

  test("a failed install releases the job and retries without starting a desktop", async () => {
    const f = setup();
    f.installer.start();
    await flush();
    f.restoreComponents();
    f.fail();
    await flush();
    expect(f.installer.getStatus().state).toBe("failed");
    f.installer.start();
    await flush();
    expect(f.install).toHaveBeenCalledTimes(2);
    f.finish();
    await flush();
    expect(f.installer.getStatus().state).toBe("ready");
  });

  test("unsupported environments cannot trigger installation", () => {
    const f = setup();
    f.unsupported();
    expect(f.installer.start().state).toBe("unsupported");
    expect(f.install).not.toHaveBeenCalled();
  });
});

test("browser and viewer share installation while a cancelled waiter stops immediately", async () => {
  const f = setup();
  const abort = new AbortController();
  const browser = f.installer
    .ensureReady(abort.signal)
    .catch((error: unknown) => error);
  const viewer = f.installer.ensureReady();
  await flush();
  expect(f.install).toHaveBeenCalledTimes(1);
  abort.abort();
  expect(await browser).toBeInstanceOf(Error);
  expect(f.installer.getStatus().state).toBe("installing");
  f.finish();
  await viewer;
  expect(f.installer.getStatus().state).toBe("ready");
});

test("failed setup reports the stage without running an automatic retry", async () => {
  const f = setup();
  const result = f.installer.ensureReady().catch((error: Error) => error);
  await flush();
  f.progress();
  f.fail();
  const error = await result;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("failed during chrome");
  expect(f.install).toHaveBeenCalledTimes(1);
});

for (const baked of [true, false]) {
  test(`${baked ? "baked" : "workspace"} Chrome starts without reinstalling completed dependencies`, async () => {
    const exists: Parameters<typeof desktopChromePath>[0] = (path) =>
      baked
        ? !String(path).endsWith(".ready")
        : path !== "/opt/google/chrome/chrome";
    const which = (name: string) => `/usr/bin/${name}`;
    const install = mock(async () => {});
    const installer = new DesktopDependencyInstaller({
      supported: () => true,
      ready: () => desktopDependenciesReady(which, exists),
      install,
      notify: async () => {},
    });
    expect(installer.getStatus().state).toBe("ready");
    await installer.ensureReady();
    expect(install).not.toHaveBeenCalled();
    if (baked) {
      expect(desktopChromePath(exists)).toBe("/opt/google/chrome/chrome");
    } else {
      expect(desktopChromePath(exists)).toContain("/external/desktop/chrome-");
    }
  });
}

test("workspace Chrome needs its completion marker before starting", () => {
  const exists: Parameters<typeof desktopChromePath>[0] = (path) =>
    path !== "/opt/google/chrome/chrome" && !String(path).endsWith(".ready");
  expect(desktopDependenciesReady((name) => `/usr/bin/${name}`, exists)).toBe(
    false,
  );
});

test("persisted Chrome on an older replacement image still needs system packages", () => {
  expect(
    desktopDependenciesReady(
      () => null,
      () => true,
    ),
  ).toBe(false);
});

test("a baked browser does not hide missing system assets", () => {
  expect(
    desktopDependenciesReady(
      (name) => `/usr/bin/${name}`,
      (path) => path !== "/usr/share/fonts/X11/misc/fonts.dir",
    ),
  ).toBe(false);
});
