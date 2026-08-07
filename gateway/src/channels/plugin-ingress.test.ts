import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
  PLUGIN_INGRESS_MANIFEST_RELPATH,
  PLUGIN_WEBHOOK_PREFIX,
  PluginIngressCache,
  discoverPluginIngress,
  ingressRoutePaths,
  parsePluginIngressManifest,
  pluginWebhookPath,
} from "./plugin-ingress.js";

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "plugin-ingress-"));
  created.push(dir);
  return dir;
}

/** Write a plugin's ingress manifest (raw string, so invalid JSON is testable). */
function writeManifest(
  workspaceDir: string,
  plugin: string,
  contents: string,
): string {
  const pluginDir = join(workspaceDir, "plugins", plugin);
  mkdirSync(join(pluginDir, "channels"), { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({ name: plugin }),
  );
  writeFileSync(join(pluginDir, PLUGIN_INGRESS_MANIFEST_RELPATH), contents);
  return pluginDir;
}

const VALID = JSON.stringify({
  routes: [
    { path: "realtime", kind: "websocket", description: "realtime events" },
  ],
});

describe("pluginWebhookPath", () => {
  it("composes under the reserved namespace", () => {
    expect(pluginWebhookPath("meeting-bot", "realtime")).toBe(
      `${PLUGIN_WEBHOOK_PREFIX}/meeting-bot/realtime`,
    );
  });

  it("normalizes a leading slash rather than emitting a double slash", () => {
    expect(pluginWebhookPath("acme", "/hook")).toBe(
      `${PLUGIN_WEBHOOK_PREFIX}/acme/hook`,
    );
  });
});

describe("parsePluginIngressManifest", () => {
  it("accepts a well-formed declaration", () => {
    const manifest = parsePluginIngressManifest(JSON.parse(VALID));
    expect(manifest.routes).toHaveLength(1);
    expect(manifest.routes[0]!.path).toBe("realtime");
  });

  it("defaults an undeclared signer to the plugin's own secret", () => {
    // The safe default: a plugin gets no reach against the platform's key
    // unless it asks for it and a guardian approves that declaration.
    const manifest = parsePluginIngressManifest(JSON.parse(VALID));
    expect(manifest.routes[0]!.signer).toBe("plugin");
  });

  it("accepts a declared vellum signer", () => {
    const manifest = parsePluginIngressManifest({
      routes: [
        {
          path: "realtime",
          kind: "websocket",
          signer: "vellum",
          handshake: "signed-headers" as const,
          description: "platform-signed events",
        },
      ],
    });
    expect(manifest.routes[0]!.signer).toBe("vellum");
  });

  it("defaults an undeclared handshake to the header scheme", () => {
    // The safe default: a route only becomes openable by a bare URL when it
    // says so, and the guardian approves a digest that records the choice.
    const manifest = parsePluginIngressManifest(JSON.parse(VALID));
    expect(manifest.routes[0]!.handshake).toBe("signed-headers");
  });

  it("accepts a signed-query handshake on a websocket route", () => {
    const manifest = parsePluginIngressManifest({
      routes: [
        {
          path: "realtime",
          kind: "websocket",
          handshake: "signed-query",
          description: "a third party dials this with a URL and nothing else",
        },
      ],
    });
    expect(manifest.routes[0]!.handshake).toBe("signed-query");
  });

  it("rejects a signed-query handshake on an http route", () => {
    // An HTTP request always has somewhere to put a header, so the weaker
    // scheme would be bought for nothing.
    expect(() =>
      parsePluginIngressManifest({
        routes: [
          {
            path: "hook",
            kind: "http",
            handshake: "signed-query",
            description: "d",
          },
        ],
      }),
    ).toThrow(/only valid for websocket/);
  });

  it("accepts a verification descriptor on an http route", () => {
    const manifest = parsePluginIngressManifest({
      routes: [
        {
          path: "events-comms",
          kind: "http",
          verification: {
            kind: "hmac",
            algorithm: "sha256",
            secret: { field: "comms_webhook_secret" },
            signature: {
              header: "X-Osis-Signature",
              encoding: "hex",
              prefix: "sha256=",
            },
            payload: ["body"],
          },
          description: "inbound comms deliveries",
        },
      ],
    });
    expect(manifest.routes[0]!.verification?.secret.field).toBe(
      "comms_webhook_secret",
    );
  });

  it("leaves verification undeclared when the manifest omits it", () => {
    // Absent means the platform scheme, exactly as before the field existed.
    const manifest = parsePluginIngressManifest(JSON.parse(VALID));
    expect(manifest.routes[0]!.verification).toBeUndefined();
  });

  it("rejects verification combined with signer vellum", () => {
    // A `vellum` route is served without a guardian approval, so a descriptor
    // there would let a plugin open an unreviewed route it verifies itself.
    expect(() =>
      parsePluginIngressManifest({
        routes: [
          {
            path: "hook",
            kind: "http",
            signer: "vellum",
            verification: {
              kind: "hmac",
              algorithm: "sha256",
              secret: { field: "vendor_secret" },
              signature: { header: "X-Sig", encoding: "hex" },
              payload: ["body"],
            },
            description: "d",
          },
        ],
      }),
    ).toThrow(/cannot be combined with signer "vellum"/);
  });

  it("rejects verification on a websocket route", () => {
    // A socket upgrade is bridged elsewhere and carries none of this.
    expect(() =>
      parsePluginIngressManifest({
        routes: [
          {
            path: "realtime",
            kind: "websocket",
            verification: {
              kind: "hmac",
              algorithm: "sha256",
              secret: { field: "vendor_secret" },
              signature: { header: "X-Sig", encoding: "hex" },
              payload: ["body"],
            },
            description: "d",
          },
        ],
      }),
    ).toThrow(/only valid for http routes/);
  });

  it("leaves a route that declares no inbound delivery a plain webhook", () => {
    // The default. A route receives a callback and the message goes no
    // further, which is what every declaration written before this meant.
    const manifest = parsePluginIngressManifest(JSON.parse(VALID));
    expect(manifest.routes[0]!.inbound).toBeUndefined();
  });

  it("accepts an empty inbound declaration and fills in the contract's shape", () => {
    const manifest = parsePluginIngressManifest({
      routes: [{ path: "hook", kind: "http", description: "d", inbound: {} }],
    });
    expect(manifest.routes[0]!.inbound?.identity).toBe("opaque");
  });

  it("rejects inbound delivery combined with signer vellum", () => {
    // A `vellum` route is served without a guardian approval. Delivering
    // messages is how a conversation starts, so a route that both skipped
    // approval and injected turns would be reach a plugin grants itself.
    expect(() =>
      parsePluginIngressManifest({
        routes: [
          {
            path: "hook",
            kind: "http",
            signer: "vellum",
            inbound: {},
            description: "d",
          },
        ],
      }),
    ).toThrow(/inbound delivery cannot be combined with signer "vellum"/);
  });

  it("rejects inbound delivery on a websocket route", () => {
    // A socket upgrade is bridged elsewhere and has no reply to read.
    expect(() =>
      parsePluginIngressManifest({
        routes: [
          {
            path: "realtime",
            kind: "websocket",
            inbound: {},
            description: "d",
          },
        ],
      }),
    ).toThrow(/inbound delivery is only valid for http routes/);
  });

  it("rejects a verification descriptor the gateway cannot run", () => {
    // Fail the manifest rather than falling back to the platform scheme: a
    // route verified differently than declared is worse than no route.
    expect(() =>
      parsePluginIngressManifest({
        routes: [
          {
            path: "hook",
            kind: "http",
            verification: {
              kind: "hmac",
              algorithm: "md5",
              secret: { field: "vendor_secret" },
              signature: { header: "X-Sig", encoding: "hex" },
              payload: ["body"],
            },
            description: "d",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a descriptor reaching for another service's credential", () => {
    expect(() =>
      parsePluginIngressManifest({
        routes: [
          {
            path: "hook",
            kind: "http",
            verification: {
              kind: "hmac",
              algorithm: "sha256",
              secret: { field: "../vellum/webhook_secret" },
              signature: { header: "X-Sig", encoding: "hex" },
              payload: ["body"],
            },
            description: "d",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects an unknown handshake", () => {
    expect(() =>
      parsePluginIngressManifest({
        routes: [
          {
            path: "realtime",
            kind: "websocket",
            handshake: "none",
            description: "x",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects an unknown signer", () => {
    expect(() =>
      parsePluginIngressManifest({
        routes: [
          {
            path: "realtime",
            kind: "http",
            signer: "anyone",
            description: "x",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects an absolute path", () => {
    expect(() =>
      parsePluginIngressManifest({
        routes: [{ path: "/hook", kind: "http", description: "d" }],
      }),
    ).toThrow();
  });

  it("rejects traversal that would clean out of the plugin's namespace", () => {
    // Velay percent-decodes and path.Cleans before matching its allowlist,
    // so `../other/steal` would otherwise escape the namespace.
    for (const path of ["../other/steal", "a/../../b", "./hook"]) {
      expect(() =>
        parsePluginIngressManifest({
          routes: [{ path, kind: "http", description: "d" }],
        }),
      ).toThrow();
    }
  });

  it("rejects percent-encoded traversal", () => {
    // Velay decodes before matching, so `%2e%2e/` would escape the
    // declaring plugin's namespace despite passing a literal-segment check.
    for (const path of [
      "%2e%2e/other/hook",
      "%2E%2E/other/hook",
      "a/%2e%2e/b",
    ]) {
      expect(() =>
        parsePluginIngressManifest({
          routes: [{ path, kind: "http", description: "d" }],
        }),
      ).toThrow();
    }
  });

  it("rejects an encoded path separator", () => {
    expect(() =>
      parsePluginIngressManifest({
        routes: [{ path: "a%2fb", kind: "http", description: "d" }],
      }),
    ).toThrow();
  });

  it("rejects malformed percent-encoding", () => {
    expect(() =>
      parsePluginIngressManifest({
        routes: [{ path: "100%", kind: "http", description: "d" }],
      }),
    ).toThrow();
  });

  it("rejects non-canonical segments that would clean to a different path", () => {
    // `a//b` cleans to `a/b`, so it would collide with a separate `a/b`
    // declaration that the exact-string duplicate check treats as distinct.
    for (const path of ["a//b", "a/./b"]) {
      expect(() =>
        parsePluginIngressManifest({
          routes: [{ path, kind: "http", description: "d" }],
        }),
      ).toThrow();
    }
  });

  it("accepts a canonical multi-segment path", () => {
    const manifest = parsePluginIngressManifest({
      routes: [{ path: "a/b/c", kind: "http", description: "d" }],
    });
    expect(manifest.routes[0]!.path).toBe("a/b/c");
  });

  it("rejects a trailing slash", () => {
    expect(() =>
      parsePluginIngressManifest({
        routes: [{ path: "hook/", kind: "http", description: "d" }],
      }),
    ).toThrow();
  });

  it("rejects query strings and fragments", () => {
    for (const path of ["hook?x=1", "hook#frag"]) {
      expect(() =>
        parsePluginIngressManifest({
          routes: [{ path, kind: "http", description: "d" }],
        }),
      ).toThrow();
    }
  });

  it("rejects an unknown transport kind", () => {
    expect(() =>
      parsePluginIngressManifest({
        routes: [{ path: "hook", kind: "grpc", description: "d" }],
      }),
    ).toThrow();
  });

  it("rejects duplicate paths", () => {
    expect(() =>
      parsePluginIngressManifest({
        routes: [
          { path: "hook", kind: "http", description: "one" },
          { path: "hook", kind: "http", description: "two" },
        ],
      }),
    ).toThrow(/duplicate route/);
  });

  it("rejects an empty route list", () => {
    expect(() => parsePluginIngressManifest({ routes: [] })).toThrow();
  });

  it("strips unknown fields rather than carrying them through", () => {
    const manifest = parsePluginIngressManifest({
      routes: [
        { path: "hook", kind: "http", description: "d", auth: "query-token" },
      ],
    });
    expect(manifest.routes[0]).not.toHaveProperty("auth");
  });
});

describe("discoverPluginIngress", () => {
  it("returns empty when there is no plugins directory", () => {
    const workspaceDir = makeWorkspace();
    expect(discoverPluginIngress({ workspaceDir })).toEqual({
      plugins: [],
      problems: [],
    });
  });

  it("discovers a declaring plugin and composes its paths", () => {
    const workspaceDir = makeWorkspace();
    writeManifest(workspaceDir, "meeting-bot", VALID);

    const { plugins, problems } = discoverPluginIngress({ workspaceDir });
    expect(problems).toEqual([]);
    expect(plugins).toHaveLength(1);
    expect(ingressRoutePaths(plugins[0]!)).toEqual([
      "/webhooks/plugins/meeting-bot/realtime",
    ]);
  });

  it("ignores plugins that declare nothing", () => {
    const workspaceDir = makeWorkspace();
    mkdirSync(join(workspaceDir, "plugins", "quiet"), { recursive: true });
    writeManifest(workspaceDir, "meeting-bot", VALID);

    const { plugins } = discoverPluginIngress({ workspaceDir });
    expect(plugins.map((p) => p.plugin)).toEqual(["meeting-bot"]);
  });

  it("skips a disabled plugin so its routes do not stay live", () => {
    const workspaceDir = makeWorkspace();
    const pluginDir = writeManifest(workspaceDir, "meeting-bot", VALID);
    writeFileSync(join(pluginDir, ".disabled"), "");

    expect(discoverPluginIngress({ workspaceDir }).plugins).toEqual([]);
  });

  it("discovers a plugin installed as a symlinked root", () => {
    // Plugins may be installed by symlinking a checkout into place, where
    // Dirent.isDirectory() is false but the target is a directory.
    const workspaceDir = makeWorkspace();
    const external = makeWorkspace();
    const target = join(external, "meeting-bot");
    mkdirSync(join(target, "channels"), { recursive: true });
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({ name: "meeting-bot" }),
    );
    writeFileSync(join(target, PLUGIN_INGRESS_MANIFEST_RELPATH), VALID);

    mkdirSync(join(workspaceDir, "plugins"), { recursive: true });
    symlinkSync(target, join(workspaceDir, "plugins", "meeting-bot"));

    const { plugins, problems } = discoverPluginIngress({ workspaceDir });
    expect(problems).toEqual([]);
    expect(plugins.map((p) => p.plugin)).toEqual(["meeting-bot"]);
  });

  it("ignores a directory with an ingress manifest but no package.json", () => {
    // Without this gate an arbitrary symlink to any directory holding a
    // manifest would hold public routes for something never loaded.
    const workspaceDir = makeWorkspace();
    const impostor = join(workspaceDir, "plugins", "impostor");
    mkdirSync(join(impostor, "channels"), { recursive: true });
    writeFileSync(join(impostor, PLUGIN_INGRESS_MANIFEST_RELPATH), VALID);
    writeManifest(workspaceDir, "meeting-bot", VALID);

    const { plugins, problems } = discoverPluginIngress({ workspaceDir });
    expect(problems).toEqual([]);
    expect(plugins.map((p) => p.plugin)).toEqual(["meeting-bot"]);
  });

  it("ignores a plain file sitting in the plugins directory", () => {
    const workspaceDir = makeWorkspace();
    mkdirSync(join(workspaceDir, "plugins"), { recursive: true });
    writeFileSync(join(workspaceDir, "plugins", ".DS_Store"), "");
    writeManifest(workspaceDir, "meeting-bot", VALID);

    const { plugins, problems } = discoverPluginIngress({ workspaceDir });
    expect(problems).toEqual([]);
    expect(plugins.map((p) => p.plugin)).toEqual(["meeting-bot"]);
  });

  it("reports a malformed declaration without dropping the others", () => {
    const workspaceDir = makeWorkspace();
    writeManifest(workspaceDir, "broken", "{ not json");
    writeManifest(
      workspaceDir,
      "invalid",
      JSON.stringify({ routes: [{ path: "/absolute", kind: "http" }] }),
    );
    writeManifest(workspaceDir, "meeting-bot", VALID);

    const { plugins, problems } = discoverPluginIngress({ workspaceDir });
    // One bad manifest must not take down discovery for every plugin.
    expect(plugins.map((p) => p.plugin)).toEqual(["meeting-bot"]);
    expect(problems.map((p) => p.plugin).sort()).toEqual(["broken", "invalid"]);
  });

  it("does not trust the manifest's own view of validity", () => {
    // A plugin repo validating its own file is a convenience for its
    // authors, not a guarantee to us — traversal is rejected here too.
    const workspaceDir = makeWorkspace();
    writeManifest(
      workspaceDir,
      "sneaky",
      JSON.stringify({
        routes: [
          { path: "../meeting-bot/realtime", kind: "http", description: "d" },
        ],
      }),
    );

    const { plugins, problems } = discoverPluginIngress({ workspaceDir });
    expect(plugins).toEqual([]);
    expect(problems).toHaveLength(1);
  });
});

describe("PluginIngressCache", () => {
  it("serves a cached snapshot within the TTL and re-scans after it", () => {
    const workspaceDir = makeWorkspace();
    const cache = new PluginIngressCache({ workspaceDir, ttlMs: 10_000 });
    expect(cache.get().plugins).toEqual([]);

    writeManifest(workspaceDir, "meeting-bot", VALID);
    // Still inside the TTL — the new plugin is not visible yet.
    expect(cache.get().plugins).toEqual([]);

    // Invalidating stands in for the TTL elapsing, so the test does not
    // have to sleep.
    cache.invalidate();
    expect(cache.get().plugins.map((p) => p.plugin)).toEqual(["meeting-bot"]);
  });

  it("force re-scans regardless of the TTL", () => {
    const workspaceDir = makeWorkspace();
    const cache = new PluginIngressCache({ workspaceDir, ttlMs: 10_000 });
    expect(cache.get().plugins).toEqual([]);

    writeManifest(workspaceDir, "meeting-bot", VALID);
    expect(cache.get({ force: true }).plugins.map((p) => p.plugin)).toEqual([
      "meeting-bot",
    ]);
  });
});
