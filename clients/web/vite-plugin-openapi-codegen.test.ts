import { afterEach, expect, test } from "bun:test";
import { waitFor } from "@testing-library/react";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build, createServer, type ViteDevServer } from "vite";

import { openApiCodegenPlugin } from "./vite-plugin-openapi-codegen";

const schemas = {
  assistant: "assistant/openapi.yaml",
  gateway: "gateway/openapi.json",
};

let fixture: string;
let server: ViteDevServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (fixture) {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function setup() {
  fixture = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "openapi-codegen-")),
  );
  const root = path.join(fixture, "clients/web");
  await mkdir(root, { recursive: true });
  for (const [service, schema] of Object.entries(schemas)) {
    await mkdir(path.join(fixture, service));
    await writeFile(path.join(fixture, schema), "initial");
  }
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { "openapi-ts": "bun generate.ts" } }),
  );
  await writeFile(
    path.join(root, "generate.ts"),
    `const values = await Promise.all(["../../assistant/openapi.yaml", "../../gateway/openapi.json"].map(file =>
      Bun.file(file).text()));
    await Bun.write("client.js", "export const endpoints = " + JSON.stringify(values));`,
  );
  return {
    root,
    configFile: false as const,
    logLevel: "silent" as const,
    plugins: [openApiCodegenPlugin()],
    server: { host: "127.0.0.1" },
    optimizeDeps: { noDiscovery: true, include: [] },
  };
}

test("regenerates before serving and after either service schema changes", async () => {
  const config = await setup();
  server = await createServer(config);
  await server.listen();
  const client = async () =>
    (await server!.transformRequest("/client.js"))?.code;
  expect(await client()).toContain('"initial"');

  for (const [service, schema] of Object.entries(schemas)) {
    await writeFile(path.join(fixture, schema), service);
    await waitFor(
      async () => expect(await client()).toContain(`"${service}"`),
      {
        timeout: 10_000,
      },
    );
  }
  expect(await client()).toContain('"assistant"');
  expect(await client()).toContain('"gateway"');
}, 30_000);

test("fails startup when generation fails instead of serving stale clients", async () => {
  const config = await setup();
  await writeFile(
    path.join(config.root, "client.js"),
    "export const stale = true",
  );
  await writeFile(path.join(config.root, "generate.ts"), "process.exit(1)");
  await expect(createServer(config)).rejects.toThrow();
});

test("an edit during startup generation is included before serving", async () => {
  const config = await setup();
  const generator = path.join(config.root, "generate.ts");
  await writeFile(
    generator,
    (await readFile(generator, "utf8")).replace(
      'await Bun.write("client.js",',
      'await Bun.write("read-started", "ready"); while (!(await Bun.file("continue").exists())) { await Bun.sleep(5); } await Bun.write("client.js",',
    ),
  );
  const starting = createServer(config);
  try {
    await waitFor(async () =>
      expect(
        await readFile(path.join(config.root, "read-started"), "utf8"),
      ).toBe("ready"),
    );
    await writeFile(path.join(fixture, "assistant/openapi.yaml"), "updated");
  } finally {
    await writeFile(path.join(config.root, "continue"), "ready");
    server = await starting;
  }
  await server.listen();
  expect((await server.transformRequest("/client.js"))?.code).toContain(
    '"updated"',
  );
});

test("production builds do not invoke development code generation", async () => {
  const config = await setup();
  await writeFile(path.join(config.root, "generate.ts"), "process.exit(1)");
  await writeFile(path.join(config.root, "index.html"), "<p>Example app</p>");
  await build({ ...config, build: { write: false } });
});
