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
import { desktopDependencyInstaller } from "../../desktop/desktop-dependencies.js";
import { ROUTES } from "./desktop-setup-routes.js";
import { NotFoundError } from "./errors.js";

const originalContainerized = process.env.IS_CONTAINERIZED;
const status = spyOn(desktopDependencyInstaller, "getStatus");
const start = spyOn(desktopDependencyInstaller, "start");

afterAll(() => {
  status.mockRestore();
  start.mockRestore();
});

beforeEach(() => {
  process.env.IS_CONTAINERIZED = "true";
  status.mockReturnValue({ state: "required" });
  start.mockReturnValue({ state: "installing", stage: "packages" });
});

afterEach(() => {
  if (originalContainerized === undefined) {
    delete process.env.IS_CONTAINERIZED;
  } else {
    process.env.IS_CONTAINERIZED = originalContainerized;
  }
  setOverridesForTesting({});
  status.mockClear();
  start.mockClear();
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
        expect(start).not.toHaveBeenCalled();
      });
    }

    test(`${route.method} refuses non-containerized assistants even with the flag enabled`, () => {
      process.env.IS_CONTAINERIZED = "false";
      setOverridesForTesting({ "assistant-desktop": true });
      expect(() => route.handler({})).toThrow(NotFoundError);
      expect(status).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    });

    test(`${route.method} serves setup only with the flag enabled in a container`, () => {
      setOverridesForTesting({ "assistant-desktop": true });
      expect(route.handler({})).toEqual(
        route.method === "GET"
          ? { state: "required" }
          : { state: "installing", stage: "packages" },
      );
      expect(route.method === "GET" ? status : start).toHaveBeenCalledTimes(1);
      expect(route.method === "GET" ? start : status).not.toHaveBeenCalled();
    });
  }
});
