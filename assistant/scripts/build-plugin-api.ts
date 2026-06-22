#!/usr/bin/env bun
/**
 * Builds the publishable `@vellumai/plugin-api` npm package: a types-first
 * package whose public `index.d.ts` is a single self-contained rollup of the
 * plugin authoring surface (`src/plugin-api/index.ts`), with the workspace
 * `@vellumai/*` contract types inlined and `zod` as the only external dep.
 *
 * Why a rollup: the authoring surface re-exports types from internal workspace
 * packages that ship `.ts` source (not published to npm), so a naive emit
 * leaves dangling `@vellumai/*` imports that no external consumer can resolve.
 * Microsoft API Extractor inlines exactly the reachable declarations into one
 * file, so a standalone plugin repo type-checks against the real contract
 * without vendoring a hand-maintained shim.
 *
 * Why a trivial runtime: inside a live assistant workspace the host
 * materializes a `node_modules/@vellumai/plugin-api` shim that re-binds the
 * already-loaded namespace off `globalThis` (see `ensure-plugin-api-shim.ts`).
 * The published `index.js` is the same re-bind so the npm package behaves
 * identically when present, and degrades to `undefined` exports when imported
 * outside a host (it is a dev-time authoring contract, not a runtime library).
 *
 * Usage:
 *   cd assistant && bun run scripts/build-plugin-api.ts --version 1.2.3
 *
 * Output: a ready-to-pack package directory (default
 * `.plugin-api-build/package`) containing `package.json`, `index.d.ts`, and
 * `index.js`. The release workflow runs `npm pack` / `npm publish` against it.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  PLUGIN_API_EXPORTS,
  PLUGIN_API_REGISTRY_KEY,
} from "../src/embedded/plugin-api.js";

const ASSISTANT_DIR = resolve(import.meta.dir, "..");
const NODE_MODULES = join(ASSISTANT_DIR, "node_modules");
const TSC = join(NODE_MODULES, ".bin", "tsc");
const API_EXTRACTOR = join(NODE_MODULES, ".bin", "api-extractor");

/** The published types reference `z.*`, so the package declares the same `zod`
 * version the assistant resolved — read from the installed package so it can
 * never drift from the contract the rollup was generated against. */
const ZOD_VERSION = (
  JSON.parse(
    readFileSync(join(NODE_MODULES, "zod", "package.json"), "utf8"),
  ) as { version: string }
).version;

interface Args {
  version: string;
  buildDir: string;
}

function parseArgs(argv: string[]): Args {
  let version = "";
  let buildDir = join(ASSISTANT_DIR, ".plugin-api-build");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--version") version = argv[++i] ?? "";
    else if (arg === "--out") buildDir = resolve(argv[++i] ?? "");
  }
  if (!version) {
    throw new Error(
      "Missing required --version <semver> (the release version to stamp).",
    );
  }
  return { version, buildDir };
}

function run(bin: string, args: string[], cwd: string): void {
  execFileSync(bin, args, { cwd, stdio: "inherit" });
}

/** Emit `.d.ts` for one workspace contract package into `dest`, resolving its
 * dependencies through `assistant/node_modules` (the layout CI produces after
 * `bun install`). Returns true if a usable `index.d.ts` was produced. */
function emitContract(pkgDir: string, dest: string): boolean {
  try {
    execFileSync(
      TSC,
      [
        "--emitDeclarationOnly",
        "--declaration",
        "--declarationMap",
        "false",
        "--sourceMap",
        "false",
        "--rootDir",
        "src",
        "--outDir",
        dest,
      ],
      { cwd: pkgDir, stdio: "pipe" },
    );
  } catch {
    // Best-effort: a package that fails to emit standalone is only a problem
    // if the public surface actually reaches it, in which case API Extractor
    // fails loudly below with the offending unresolved import.
  }
  return existsSync(join(dest, "index.d.ts"));
}

interface ContractPackageJson {
  name: string;
  version?: string;
  type?: string;
  exports?: Record<string, unknown>;
}

/** Write a `package.json` for an emitted contract whose `types`/`exports`
 * resolve to the `.d.ts` files (not the unpublished `src/*.ts`). API
 * Extractor resolves a `bundledPackage`'s entry through its real
 * `package.json`, so without this it would follow `exports` back to source
 * and reject the `.ts`. Subpath keys map to same-named `.d.ts` siblings. */
function writeContractManifest(srcManifestPath: string, destDir: string): void {
  const orig = JSON.parse(
    readFileSync(srcManifestPath, "utf8"),
  ) as ContractPackageJson;
  const origExports = orig.exports ?? { ".": "./src/index.ts" };
  const exports: Record<string, string> = {};
  for (const key of Object.keys(origExports)) {
    exports[key] = key === "." ? "./index.d.ts" : `${key}.d.ts`;
  }
  writeFileSync(
    join(destDir, "package.json"),
    `${JSON.stringify(
      {
        name: orig.name,
        version: orig.version ?? "0.0.0",
        type: orig.type ?? "module",
        types: "./index.d.ts",
        exports,
      },
      null,
      2,
    )}\n`,
  );
}

function buildRuntimeShim(): string {
  const key = JSON.stringify(PLUGIN_API_REGISTRY_KEY.description ?? "");
  const lines = [
    "// Generated by scripts/build-plugin-api.ts — do not edit by hand.",
    `const api = globalThis[Symbol.for(${key})] ?? {};`,
    ...PLUGIN_API_EXPORTS.map((name) => `export const ${name} = api.${name};`),
  ];
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const { version, buildDir } = parseArgs(Bun.argv.slice(2));

  const outDir = join(buildDir, "out");
  const pkgDir = join(buildDir, "package");
  const nodeModulesDir = join(buildDir, "node_modules");
  const vellumOverlay = join(nodeModulesDir, "@vellumai");

  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(vellumOverlay, { recursive: true });

  // 1. Emit declarations for the authoring surface and everything it reaches.
  console.log("[plugin-api] emitting authoring-surface declarations…");
  run(TSC, ["-p", "tsconfig.plugin-api.json"], ASSISTANT_DIR);

  // 2. Emit each `@vellumai/*` contract the surface reaches into an overlay
  //    `node_modules`, each with a `package.json` pointing at its `.d.ts`, so
  //    API Extractor inlines them (as `bundledPackages`) instead of leaving
  //    dangling `@vellumai/*` imports an external consumer can't resolve.
  console.log("[plugin-api] emitting workspace contract declarations…");
  const vellumDir = join(NODE_MODULES, "@vellumai");
  const bundled: string[] = [];
  for (const name of readdirSync(vellumDir)) {
    const dir = join(vellumDir, name);
    if (!existsSync(join(dir, "tsconfig.json"))) continue;
    if (!existsSync(join(dir, "src"))) continue;
    const dest = join(vellumOverlay, name);
    if (emitContract(dir, dest)) {
      writeContractManifest(join(dir, "package.json"), dest);
      bundled.push(`@vellumai/${name}`);
    }
  }
  bundled.sort();

  // `zod` is the sole external dependency of the rolled-up surface; symlink it
  // so the compiler resolves it while API Extractor leaves it as an import.
  symlinkSync(join(NODE_MODULES, "zod"), join(nodeModulesDir, "zod"), "dir");

  // 3. Generate the API Extractor compiler tsconfig + config.
  writeFileSync(
    join(buildDir, "tsconfig.dts.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          skipLibCheck: true,
          types: [],
        },
        include: ["dts/**/*.d.ts"],
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(
    join(buildDir, "api-extractor.json"),
    `${JSON.stringify(
      {
        $schema:
          "https://developer.microsoft.com/json-schemas/api-extractor/v7/api-extractor.schema.json",
        projectFolder: ".",
        mainEntryPointFilePath: "<projectFolder>/dts/plugin-api/index.d.ts",
        bundledPackages: bundled,
        compiler: { tsconfigFilePath: "<projectFolder>/tsconfig.dts.json" },
        dtsRollup: {
          enabled: true,
          untrimmedFilePath: "<projectFolder>/out/index.d.ts",
        },
        apiReport: { enabled: false },
        docModel: { enabled: false },
        tsdocMetadata: { enabled: false },
        messages: {
          compilerMessageReporting: { default: { logLevel: "none" } },
          extractorMessageReporting: { default: { logLevel: "none" } },
        },
      },
      null,
      2,
    )}\n`,
  );

  // 4. Roll up the reachable declarations into a single self-contained file.
  console.log("[plugin-api] rolling up declarations with API Extractor…");
  run(API_EXTRACTOR, ["run", "--local", "-c", "api-extractor.json"], buildDir);

  const rollup = join(outDir, "index.d.ts");
  if (!existsSync(rollup)) {
    throw new Error(`API Extractor did not produce ${rollup}`);
  }

  // 5. Assemble the publishable package directory.
  mkdirSync(pkgDir, { recursive: true });
  cpSync(rollup, join(pkgDir, "index.d.ts"));
  writeFileSync(join(pkgDir, "index.js"), buildRuntimeShim());
  writeFileSync(
    join(pkgDir, "package.json"),
    `${JSON.stringify(
      {
        name: "@vellumai/plugin-api",
        version,
        description:
          "Public TypeScript authoring contract for Vellum assistant plugins.",
        license: "MIT",
        type: "module",
        main: "./index.js",
        types: "./index.d.ts",
        exports: {
          ".": {
            types: "./index.d.ts",
            import: "./index.js",
            default: "./index.js",
          },
        },
        files: ["index.js", "index.d.ts"],
        dependencies: { zod: ZOD_VERSION },
        publishConfig: { access: "public" },
        repository: {
          type: "git",
          url: "git+https://github.com/vellum-ai/vellum-assistant.git",
          directory: "assistant/src/plugin-api",
        },
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `[plugin-api] built @vellumai/plugin-api@${version} → ${pkgDir}\n` +
      `[plugin-api] inlined contracts: ${bundled.join(", ")}`,
  );
}

main();
