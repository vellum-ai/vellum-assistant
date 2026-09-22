import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { desktopDependencies } from "../../desktop/desktop-dependencies.js";
import { ROUTES } from "./desktop-setup-routes.js";
import { NotFoundError } from "./errors.js";

const originalContainerized = process.env.IS_CONTAINERIZED;
const originalPlatform = process.env.IS_PLATFORM;
const status = spyOn(desktopDependencies, "getStatus");

afterAll(() => {
  status.mockRestore();
});

beforeEach(() => {
  process.env.IS_CONTAINERIZED = "true";
  process.env.IS_PLATFORM = "true";
  status.mockReturnValue({ state: "ready" });
});

afterEach(() => {
  if (originalContainerized === undefined) {
    delete process.env.IS_CONTAINERIZED;
  } else {
    process.env.IS_CONTAINERIZED = originalContainerized;
  }
  if (originalPlatform === undefined) {
    delete process.env.IS_PLATFORM;
  } else {
    process.env.IS_PLATFORM = originalPlatform;
  }
  setOverridesForTesting({});
  status.mockClear();
});

describe("desktop setup route feature gate", () => {
  for (const route of ROUTES) {
    for (const flag of [false, undefined]) {
      test(`${route.method} refuses a disabled or missing flag (${flag}) without touching setup`, () => {
        setOverridesForTesting(
          flag === undefined ? {} : { "assistant-desktop": flag },
        );
        expect(() => route.handler({})).toThrow(NotFoundError);
        expect(status).not.toHaveBeenCalled();
      });
    }

    test(`${route.method} refuses non-containerized assistants even with the flag enabled`, () => {
      process.env.IS_CONTAINERIZED = "false";
      setOverridesForTesting({ "assistant-desktop": true });
      expect(() => route.handler({})).toThrow(NotFoundError);
      expect(status).not.toHaveBeenCalled();
    });

    test(`${route.method} rejects self-hosted Docker assistants without inspecting dependencies`, () => {
      process.env.IS_PLATFORM = "false";
      setOverridesForTesting({ "assistant-desktop": true });
      expect(() => route.handler({})).toThrow(NotFoundError);
      expect(status).not.toHaveBeenCalled();
    });

    test(`${route.method} serves setup only for enabled platform containers`, () => {
      setOverridesForTesting({ "assistant-desktop": true });
      expect(route.handler({})).toEqual({
        state: "ready",
        automationActive: false,
      });
      expect(status).toHaveBeenCalledTimes(1);
    });
  }
});
