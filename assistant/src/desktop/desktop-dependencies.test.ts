import { describe, expect, mock, test } from "bun:test";

import {
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
