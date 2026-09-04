import { mock } from "bun:test";
import { runBundleFeatureSuite } from "@vellumai/electron-desktop/testing/bundle-feature-suite";

mock.module("./ipc.client", () => ({
  handle: () => undefined,
  on: () => undefined,
}));

await runBundleFeatureSuite("Windows", () => import("./features/bundles"), {
  appData: "C:\\Vellum",
  config: "C:\\Vellum\\config",
  bundleFile: "C:\\bundle.vellum",
  command: "vellum.exe",
});
