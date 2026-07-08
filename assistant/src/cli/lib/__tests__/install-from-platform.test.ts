/**
 * Tests for {@link installPluginFromPlatform}.
 *
 * The platform install endpoint is replaced by an in-memory `fetch` fixture
 * that serves a gzipped tarball with the metadata headers (`ETag`,
 * `X-Plugin-Ref`, `X-Plugin-Repo`, `X-Plugin-Source-Path`) the real endpoint
 * sends. No globals are monkey-patched; the workspace plugins dir is injected.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { FetchLike } from "../fetch-like.js";
import { readInstallMeta } from "../install-from-github.js";
import {
  extractPluginTarball,
  installPluginFromPlatform,
  PluginArchiveError,
  PluginIntegrityError,
  PluginRateLimitedError,
  PluginTooLargeError,
} from "../install-from-platform.js";

const PLATFORM = "https://platform.test";

// ─── Tar/gzip fixtures ───────────────────────────────────────────────────────

interface TarEntry {
  name: string;
  content: string;
}

/** Build a minimal ustar tar buffer from a flat list of file entries. */
function makeTar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content, "utf-8");
    const header = Buffer.alloc(512, 0);
    header.write(entry.name, 0, 100, "utf-8");
    header.write("0000644\0", 100, 8, "utf-8"); // mode
    header.write("0000000\0", 108, 8, "utf-8"); // uid
    header.write("0000000\0", 116, 8, "utf-8"); // gid
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, 12);
    header.write("00000000000\0", 136, 12, "utf-8"); // mtime
    header[156] = 0x30; // typeflag '0' (regular file)
    header.write("ustar\0", 257, 6, "utf-8");
    header.write("00", 263, 2, "utf-8");
    // Checksum: sum of all bytes with the checksum field treated as spaces.
    for (let i = 148; i < 156; i++) {
      header[i] = 0x20;
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) {
      sum += header[i]!;
    }
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf-8");

    blocks.push(header);
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0);
    data.copy(padded);
    blocks.push(padded);
  }
  // Two zero blocks terminate the archive.
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

interface FetchFixtureOpts {
  entries?: TarEntry[];
  /** Override the ETag digest (defaults to the real sha256 of the body). */
  etag?: string;
  ref?: string;
  repo?: string;
  sourcePath?: string;
  /** Non-2xx status to serve instead of the archive. */
  status?: number;
  /**
   * Serve an uncompressed POSIX tar body while still advertising
   * `Content-Type: application/gzip` (what the platform actually does).
   * Defaults to serving a real gzip stream.
   */
  plainTar?: boolean;
  /** Header capture: called with the request headers on each fetch. */
  onRequest?: (url: string, headers: Headers) => void;
}

/** A `fetch` that serves the plugin install endpoint from an in-memory tarball. */
function makeInstallFetch(opts: FetchFixtureOpts): FetchLike {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    opts.onRequest?.(url, headers);

    if (opts.status && opts.status >= 400) {
      return new Response(JSON.stringify({ detail: "error" }), {
        status: opts.status,
      });
    }

    const tar = makeTar(opts.entries ?? []);
    const body = opts.plainTar ? tar : Buffer.from(gzipSync(tar));
    const etag = opts.etag ?? `"sha256:${sha256Hex(body)}"`;
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        ETag: etag,
        "X-Plugin-Ref": opts.ref ?? "a".repeat(40),
        "X-Plugin-Repo": opts.repo ?? "vellum-ai/reading-pal",
        ...(opts.sourcePath ? { "X-Plugin-Source-Path": opts.sourcePath } : {}),
      },
    });
  }) as FetchLike;
}

// ─── Test scaffolding ────────────────────────────────────────────────────────

let workspaceDir: string;
let pluginsDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "plugin-platform-"));
  pluginsDir = join(workspaceDir, "plugins");
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

const noSleep = async () => {};

// ─── Success ─────────────────────────────────────────────────────────────────

describe("installPluginFromPlatform — success", () => {
  test("downloads, verifies, and extracts files at the plugin root", async () => {
    const entries: TarEntry[] = [
      { name: "plugin.json", content: '{"name":"reading-pal"}' },
      { name: "README.md", content: "# reading pal" },
      { name: "skills/read/SKILL.md", content: "skill body" },
    ];
    const fetchFn = makeInstallFetch({
      entries,
      ref: "b".repeat(40),
      repo: "vellum-ai/reading-pal",
    });

    const result = await installPluginFromPlatform(
      { name: "reading-pal" },
      {
        fetch: fetchFn,
        platformBaseUrl: PLATFORM,
        workspacePluginsDir: pluginsDir,
      },
    );

    const target = join(pluginsDir, "reading-pal");
    expect(result.name).toBe("reading-pal");
    expect(result.target).toBe(target);
    expect(result.fileCount).toBe(3);
    expect(result.commit).toBe("b".repeat(40));
    expect(result.ref).toBe("b".repeat(40));

    // Files land at the top level — no {owner}-{repo}-{sha}/ wrapper dir.
    expect(readFileSync(join(target, "plugin.json"), "utf-8")).toContain(
      "reading-pal",
    );
    expect(existsSync(join(target, "README.md"))).toBe(true);
    expect(existsSync(join(target, "skills", "read", "SKILL.md"))).toBe(true);

    // Provenance records the pinned commit and the verified ETag.
    const meta = readInstallMeta(target);
    expect(meta?.commit).toBe("b".repeat(40));
    expect(meta?.source.repo).toBe("reading-pal");
    expect(meta?.source.owner).toBe("vellum-ai");
    expect(meta?.etag?.startsWith('"sha256:')).toBe(true);
  });

  test("sends the API key as an Api-Key Authorization header when present", async () => {
    const captured: { auth: string | null } = { auth: null };
    const fetchFn = makeInstallFetch({
      entries: [{ name: "plugin.json", content: "{}" }],
      onRequest: (_url, headers) => {
        captured.auth = headers.get("authorization");
      },
    });

    await installPluginFromPlatform(
      { name: "reading-pal" },
      {
        fetch: fetchFn,
        platformBaseUrl: PLATFORM,
        apiKey: "secret-key",
        workspacePluginsDir: pluginsDir,
      },
    );

    expect(captured.auth).toBe("Api-Key secret-key");
  });

  test("forwards attribution query params", async () => {
    let seenUrl = "";
    const fetchFn = makeInstallFetch({
      entries: [{ name: "plugin.json", content: "{}" }],
      onRequest: (url) => {
        seenUrl = url;
      },
    });

    await installPluginFromPlatform(
      {
        name: "reading-pal",
        installationId: "device-1",
        conversationId: "conv-9",
        assistantVersion: "1.2.3",
      },
      {
        fetch: fetchFn,
        platformBaseUrl: PLATFORM,
        workspacePluginsDir: pluginsDir,
      },
    );

    expect(seenUrl).toContain("/v1/plugins/reading-pal/install/");
    expect(seenUrl).toContain("installation_id=device-1");
    expect(seenUrl).toContain("conversation_id=conv-9");
    expect(seenUrl).toContain("assistant_version=1.2.3");
  });

  test("requests Accept: */* (platform 406s a specific gzip Accept)", async () => {
    const captured: { accept: string | null } = { accept: null };
    const fetchFn = makeInstallFetch({
      entries: [{ name: "plugin.json", content: "{}" }],
      onRequest: (_url, headers) => {
        captured.accept = headers.get("accept");
      },
    });

    await installPluginFromPlatform(
      { name: "reading-pal" },
      {
        fetch: fetchFn,
        platformBaseUrl: PLATFORM,
        workspacePluginsDir: pluginsDir,
      },
    );

    expect(captured.accept).toBe("*/*");
  });

  test("extracts an uncompressed tar body served as application/gzip", async () => {
    const fetchFn = makeInstallFetch({
      entries: [
        { name: "plugin.json", content: '{"name":"reading-pal"}' },
        { name: "skills/read/SKILL.md", content: "skill body" },
      ],
      plainTar: true,
    });

    const result = await installPluginFromPlatform(
      { name: "reading-pal" },
      {
        fetch: fetchFn,
        platformBaseUrl: PLATFORM,
        workspacePluginsDir: pluginsDir,
      },
    );

    const target = join(pluginsDir, "reading-pal");
    expect(result.fileCount).toBe(2);
    expect(readFileSync(join(target, "plugin.json"), "utf-8")).toContain(
      "reading-pal",
    );
    expect(existsSync(join(target, "skills", "read", "SKILL.md"))).toBe(true);
  });
});

// ─── Integrity ───────────────────────────────────────────────────────────────

describe("installPluginFromPlatform — integrity", () => {
  test("aborts on an ETag sha256 mismatch and writes nothing", async () => {
    const fetchFn = makeInstallFetch({
      entries: [{ name: "plugin.json", content: "{}" }],
      etag: `"sha256:${"0".repeat(64)}"`,
    });

    await expect(
      installPluginFromPlatform(
        { name: "reading-pal" },
        {
          fetch: fetchFn,
          platformBaseUrl: PLATFORM,
          workspacePluginsDir: pluginsDir,
        },
      ),
    ).rejects.toBeInstanceOf(PluginIntegrityError);

    expect(existsSync(join(pluginsDir, "reading-pal"))).toBe(false);
  });
});

// ─── Path traversal ──────────────────────────────────────────────────────────

describe("extractPluginTarball — path traversal", () => {
  test("rejects an entry that escapes the target dir", () => {
    const dest = mkdtempSync(join(tmpdir(), "extract-"));
    try {
      const tar = makeTar([{ name: "../evil.txt", content: "pwned" }]);
      expect(() => extractPluginTarball("evil", gzipSync(tar), dest)).toThrow(
        PluginArchiveError,
      );
      // The escaping file must not have been written outside dest.
      expect(existsSync(join(dest, "..", "evil.txt"))).toBe(false);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("extracts a normal nested entry", () => {
    const dest = mkdtempSync(join(tmpdir(), "extract-"));
    try {
      const tar = makeTar([{ name: "a/b/c.txt", content: "ok" }]);
      const count = extractPluginTarball("good", gzipSync(tar), dest);
      expect(count).toBe(1);
      expect(readFileSync(join(dest, "a", "b", "c.txt"), "utf-8")).toBe("ok");
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});

// ─── HTTP error handling ─────────────────────────────────────────────────────

describe("installPluginFromPlatform — HTTP errors", () => {
  test("404 → PluginNotFoundError", async () => {
    const fetchFn = makeInstallFetch({ status: 404 });
    await expect(
      installPluginFromPlatform(
        { name: "missing" },
        {
          fetch: fetchFn,
          platformBaseUrl: PLATFORM,
          workspacePluginsDir: pluginsDir,
        },
      ),
    ).rejects.toMatchObject({ name: "PluginNotFoundError" });
  });

  test("413 → PluginTooLargeError", async () => {
    const fetchFn = makeInstallFetch({ status: 413 });
    await expect(
      installPluginFromPlatform(
        { name: "huge" },
        {
          fetch: fetchFn,
          platformBaseUrl: PLATFORM,
          workspacePluginsDir: pluginsDir,
        },
      ),
    ).rejects.toBeInstanceOf(PluginTooLargeError);
  });

  test("429 retries then throws PluginRateLimitedError when exhausted", async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls++;
      return new Response(JSON.stringify({ code: "rate_limit_exceeded" }), {
        status: 429,
      });
    };
    await expect(
      installPluginFromPlatform(
        { name: "spammy" },
        {
          fetch: fetchFn,
          platformBaseUrl: PLATFORM,
          workspacePluginsDir: pluginsDir,
          maxAttempts: 3,
          sleep: noSleep,
        },
      ),
    ).rejects.toBeInstanceOf(PluginRateLimitedError);
    expect(calls).toBe(3);
  });

  test("429 then success recovers", async () => {
    let calls = 0;
    const good = makeInstallFetch({
      entries: [{ name: "plugin.json", content: "{}" }],
    });
    const fetchFn: FetchLike = async (input, init) => {
      calls++;
      if (calls === 1) {
        return new Response("{}", { status: 429 });
      }
      return good(input, init);
    };
    const result = await installPluginFromPlatform(
      { name: "reading-pal" },
      {
        fetch: fetchFn,
        platformBaseUrl: PLATFORM,
        workspacePluginsDir: pluginsDir,
        sleep: noSleep,
      },
    );
    expect(result.fileCount).toBe(1);
    expect(calls).toBe(2);
  });

  test("502 retries then surfaces a retryable source error", async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls++;
      return new Response(JSON.stringify({ detail: "Failed to assemble" }), {
        status: 502,
      });
    };
    await expect(
      installPluginFromPlatform(
        { name: "flaky" },
        {
          fetch: fetchFn,
          platformBaseUrl: PLATFORM,
          workspacePluginsDir: pluginsDir,
          maxAttempts: 2,
          sleep: noSleep,
        },
      ),
    ).rejects.toMatchObject({ name: "PluginSourceUnavailableError" });
    expect(calls).toBe(2);
  });
});

// ─── Already installed ───────────────────────────────────────────────────────

describe("installPluginFromPlatform — force", () => {
  test("refuses to overwrite an existing install without force", async () => {
    const fetchFn = makeInstallFetch({
      entries: [{ name: "plugin.json", content: "{}" }],
    });
    await installPluginFromPlatform(
      { name: "reading-pal" },
      {
        fetch: fetchFn,
        platformBaseUrl: PLATFORM,
        workspacePluginsDir: pluginsDir,
      },
    );
    await expect(
      installPluginFromPlatform(
        { name: "reading-pal" },
        {
          fetch: fetchFn,
          platformBaseUrl: PLATFORM,
          workspacePluginsDir: pluginsDir,
        },
      ),
    ).rejects.toMatchObject({ name: "PluginAlreadyInstalledError" });
  });

  test("force overwrites an existing install", async () => {
    const first = makeInstallFetch({
      entries: [{ name: "plugin.json", content: '{"v":1}' }],
    });
    await installPluginFromPlatform(
      { name: "reading-pal" },
      {
        fetch: first,
        platformBaseUrl: PLATFORM,
        workspacePluginsDir: pluginsDir,
      },
    );
    const second = makeInstallFetch({
      entries: [{ name: "plugin.json", content: '{"v":2}' }],
    });
    const result = await installPluginFromPlatform(
      { name: "reading-pal", force: true },
      {
        fetch: second,
        platformBaseUrl: PLATFORM,
        workspacePluginsDir: pluginsDir,
      },
    );
    expect(result.fileCount).toBe(1);
    expect(
      readFileSync(join(pluginsDir, "reading-pal", "plugin.json"), "utf-8"),
    ).toContain('"v":2');
  });
});
