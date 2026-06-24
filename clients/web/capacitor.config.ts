import type { CapacitorConfig } from "@capacitor/cli";

// `server.url` is baked into native Capacitor config by `cap sync`, so
// whatever URL resolves here at sync time is what the archived mobile build
// ships with. Defaults to dev; set `VELLUM_ENVIRONMENT=production` before
// syncing a production mobile build.
//
// The `/assistant` suffix is deliberate — booting on the bare host lands
// on the marketing page, whose CTA redirects to `www.vellum.ai/assistant`
// and bounces non-prod shells off their own host.
const env = process.env.VELLUM_ENVIRONMENT ?? "dev";

const SERVER_URL =
  env === "production"
    ? "https://www.vellum.ai/assistant"
    : env === "staging"
      ? "https://staging-assistant.vellum.ai/assistant"
      : "https://dev-assistant.vellum.ai/assistant";

const SCHEME_NAMES: Record<string, string> = {
  production: "App",
  staging: "App Staging",
  dev: "App Dev",
};

const config: CapacitorConfig = {
  // NOTE: Capacitor's CLI requires Java-package form here because Android
  // uses this value as its application namespace. The real iOS bundle IDs are
  // set via `PRODUCT_BUNDLE_IDENTIFIER` in the Xcode project.
  appId: "ai.vocify.vellumassistant",
  appName: "Vellum",
  webDir: "capacitor-shell",
  server: {
    url: SERVER_URL,
    cleartext: false,
  },
  ios: {
    // Native iOS project lives as a peer to `clients/web/` at `clients/ios/`,
    // not nested inside the web app. This keeps the Capacitor shell
    // alongside the other client apps (`clients/web`, future `clients/...`)
    // rather than burying it inside the web tree.
    path: "../ios",
    // Map to `WKWebView.scrollView.contentInsetAdjustmentBehavior = .never`.
    // Without this, iOS WKWebView defaults to `.automatic` and pads the
    // scroll content by the safe-area insets itself, which has two
    // unwanted effects inside the Capacitor shell:
    //   1. `env(safe-area-inset-*)` resolves to 0 because, from the
    //      webview's perspective, it already sits inside the safe area.
    //      That makes the CSS safe-area padding on `<Layout>` /
    //      `<AssistantShell>` a no-op — the header and composer end up
    //      covered by the notch and home indicator.
    //   2. The surface colour on the header stops at the safe-area line
    //      instead of extending into the notch, leaving a transparent
    //      strip at the top.
    // Setting this to `never` lets the page own the inset compensation via
    // `env(safe-area-inset-*)`, which is what PRs #4821 and #4832 assume.
    contentInset: "never",
    scheme: SCHEME_NAMES[env] ?? "App",
  },
  android: {
    // Native Android project lives as a peer to `clients/web/` at
    // `clients/android/`, matching the iOS shell layout.
    path: "../android",
  },
};

export default config;
