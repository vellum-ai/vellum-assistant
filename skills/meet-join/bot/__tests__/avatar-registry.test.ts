/**
 * Tests for the avatar renderer registry.
 *
 * Coverage:
 *   - `registerAvatarRenderer` + `resolveAvatarRenderer` happy path.
 *   - Short-circuit when `config.enabled === false` → `null`.
 *   - Short-circuit when `config.renderer === "noop"` → `null`
 *     (even though the noop renderer is registered — the registry
 *     treats the explicit noop id as an off-switch at the resolver
 *     level so callers can avoid starting a no-op lifecycle).
 *   - `AvatarRendererUnavailableError` surfaces for unknown ids.
 *   - Factory-thrown `AvatarRendererUnavailableError` propagates
 *     through `resolveAvatarRenderer` unchanged.
 *   - Registry isolation helper resets state between tests.
 *
 * We use {@link FakeAvatarRenderer} from `avatar-interface.test.ts` as
 * the per-test renderer fixture so the factory shape under test is the
 * same shape future renderer PRs will implement.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  AvatarRendererUnavailableError,
  __resetAvatarRegistryForTests,
  isAvatarRendererRegistered,
  listRegisteredAvatarRenderers,
  registerAvatarRenderer,
  resolveAvatarRenderer,
  type AvatarConfig,
  type AvatarRendererDeps,
} from "../src/media/avatar/index.js";

import { FakeAvatarRenderer } from "./avatar-interface.test.js";

function makeConfig(overrides: Partial<AvatarConfig> = {}): AvatarConfig {
  return {
    enabled: true,
    renderer: "fake",
    ...overrides,
  };
}

const noDeps: AvatarRendererDeps = {};

describe("resolveAvatarRenderer", () => {
  afterEach(() => {
    __resetAvatarRegistryForTests();
  });

  test("returns null when `config.enabled` is false", () => {
    // Register a fake so we can prove the short-circuit fires BEFORE
    // the factory lookup — the factory must not be invoked.
    let invocations = 0;
    registerAvatarRenderer("fake", () => {
      invocations += 1;
      return new FakeAvatarRenderer();
    });

    const renderer = resolveAvatarRenderer(
      makeConfig({ enabled: false }),
      noDeps,
    );
    expect(renderer).toBeNull();
    expect(invocations).toBe(0);
  });

  test("returns null when `config.renderer` is noop (regardless of registration)", () => {
    // Register noop so the factory exists; we still expect `null`
    // because the resolver treats noop as an off-switch at the
    // resolver level.
    let invocations = 0;
    registerAvatarRenderer("noop", () => {
      invocations += 1;
      return new FakeAvatarRenderer({ id: "noop" });
    });

    const renderer = resolveAvatarRenderer(
      makeConfig({ renderer: "noop" }),
      noDeps,
    );
    expect(renderer).toBeNull();
    expect(invocations).toBe(0);
  });

  test("resolves a registered factory by id", () => {
    const constructed: FakeAvatarRenderer[] = [];
    registerAvatarRenderer("fake", () => {
      const r = new FakeAvatarRenderer();
      constructed.push(r);
      return r;
    });

    const renderer = resolveAvatarRenderer(makeConfig(), noDeps);
    expect(renderer).not.toBeNull();
    expect(renderer).toBeInstanceOf(FakeAvatarRenderer);
    expect(constructed).toHaveLength(1);
    expect(renderer).toBe(constructed[0]);
  });

  test("forwards the caller's config + deps into the factory", () => {
    const captured: Array<{
      config: AvatarConfig;
      deps: AvatarRendererDeps;
    }> = [];
    registerAvatarRenderer("fake", (config, deps) => {
      captured.push({ config, deps });
      return new FakeAvatarRenderer();
    });

    const deps: AvatarRendererDeps = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const config: AvatarConfig = makeConfig({
      apiKey: "X",
      extraField: 42,
    });
    resolveAvatarRenderer(config, deps);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.config).toEqual(config);
    expect(captured[0]!.deps).toBe(deps);
  });

  test("each resolve call produces a fresh instance", () => {
    registerAvatarRenderer("fake", () => new FakeAvatarRenderer());
    const a = resolveAvatarRenderer(makeConfig(), noDeps);
    const b = resolveAvatarRenderer(makeConfig(), noDeps);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  test("throws AvatarRendererUnavailableError for an unknown id", () => {
    // Nothing registered → any id is unknown.
    let err: unknown;
    try {
      resolveAvatarRenderer(makeConfig({ renderer: "nope" }), noDeps);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(AvatarRendererUnavailableError);
    const avatarErr = err as AvatarRendererUnavailableError;
    expect(avatarErr.rendererId).toBe("nope");
    expect(avatarErr.reason).toContain("no factory registered");
    expect(avatarErr.reason).toContain("nope");
  });

  test("unknown-id error lists available ids for diagnostics", () => {
    registerAvatarRenderer("fake", () => new FakeAvatarRenderer());
    registerAvatarRenderer("other", () => new FakeAvatarRenderer({ id: "other" }));

    let err: unknown;
    try {
      resolveAvatarRenderer(makeConfig({ renderer: "missing" }), noDeps);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(AvatarRendererUnavailableError);
    const message = (err as AvatarRendererUnavailableError).reason;
    expect(message).toContain("fake");
    expect(message).toContain("other");
  });

  test("propagates AvatarRendererUnavailableError thrown by the factory", () => {
    registerAvatarRenderer("simli", () => {
      throw new AvatarRendererUnavailableError(
        "simli",
        "missing SIMLI_API_KEY credential",
      );
    });

    let err: unknown;
    try {
      resolveAvatarRenderer(makeConfig({ renderer: "simli" }), noDeps);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(AvatarRendererUnavailableError);
    const avatarErr = err as AvatarRendererUnavailableError;
    expect(avatarErr.rendererId).toBe("simli");
    expect(avatarErr.reason).toBe("missing SIMLI_API_KEY credential");
  });

  test("non-AvatarRendererUnavailableError thrown by factory propagates as-is", () => {
    registerAvatarRenderer("broken", () => {
      throw new TypeError("unexpected factory bug");
    });

    expect(() => {
      resolveAvatarRenderer(makeConfig({ renderer: "broken" }), noDeps);
    }).toThrow(TypeError);
  });
});

describe("registerAvatarRenderer", () => {
  afterEach(() => {
    __resetAvatarRegistryForTests();
  });

  test("later registration replaces an earlier one for the same id", () => {
    const firstRenderer = new FakeAvatarRenderer({ id: "fake" });
    const secondRenderer = new FakeAvatarRenderer({ id: "fake" });

    registerAvatarRenderer("fake", () => firstRenderer);
    registerAvatarRenderer("fake", () => secondRenderer);

    const resolved = resolveAvatarRenderer(
      { enabled: true, renderer: "fake" },
      noDeps,
    );
    expect(resolved).toBe(secondRenderer);
  });

  test("isAvatarRendererRegistered reflects registration state", () => {
    expect(isAvatarRendererRegistered("fake")).toBe(false);
    registerAvatarRenderer("fake", () => new FakeAvatarRenderer());
    expect(isAvatarRendererRegistered("fake")).toBe(true);
    __resetAvatarRegistryForTests();
    expect(isAvatarRendererRegistered("fake")).toBe(false);
  });

  test("listRegisteredAvatarRenderers returns sorted ids", () => {
    registerAvatarRenderer("simli", () => new FakeAvatarRenderer({ id: "simli" }));
    registerAvatarRenderer("noop", () => new FakeAvatarRenderer({ id: "noop" }));
    registerAvatarRenderer("alpha", () => new FakeAvatarRenderer({ id: "alpha" }));
    expect(listRegisteredAvatarRenderers()).toEqual(["alpha", "noop", "simli"]);
  });
});

describe("noop renderer self-registration", () => {
  test("the resolver short-circuits renderer === 'noop' even after a reset", () => {
    // The noop file's import-time `registerAvatarRenderer("noop", ...)`
    // call ran once when the barrel was first loaded. Because the
    // registry's internal Map is a module-local singleton and ES module
    // imports are cached, re-importing the file doesn't re-run the
    // side effect — so `__resetAvatarRegistryForTests()` alone would
    // leave the registry empty here.
    //
    // What matters for the noop path is that `resolveAvatarRenderer`
    // short-circuits on `renderer === "noop"` AT THE RESOLVER LEVEL
    // without needing a factory to exist. That's the invariant
    // callers rely on — they never have to register anything to use
    // the "off" state.
    __resetAvatarRegistryForTests();
    expect(isAvatarRendererRegistered("noop")).toBe(false);
    const renderer = resolveAvatarRenderer(
      { enabled: true, renderer: "noop" },
      noDeps,
    );
    expect(renderer).toBeNull();
  });
});
