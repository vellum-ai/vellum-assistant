import { mock } from "bun:test";
import { runBundleFeatureSuite } from "@vellumai/electron-desktop/testing/bundle-feature-suite";

mock.module("./ipc.client", () => ({
  handle: () => undefined,
  on: () => undefined,
}));

await runBundleFeatureSuite("Linux", () => import("./features/bundles"), {
  appData: "/home/user/.config/Vellum",
  config: "/home/user/.config/vellum",
  bundleFile: "/home/user/bundle.vellum",
  command: "/opt/vellum/bun",
});
