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
  for (const service of ["assistant", "gateway"]) {
    await mkdir(path.join(fixture, service));
    await writeFile(path.join(fixture, service, "openapi.yaml"), "initial");
  }
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { "openapi-ts": "bun generate.ts" } }),
  );
  await writeFile(
    path.join(root, "generate.ts"),
    `const values = await Promise.all(["assistant", "gateway"].map(service =>
      Bun.file("../../" + service + "/openapi.yaml").text()));
    await Bun.write("client.js", "export const endpoints = " + JSON.stringify(values));`,
  );
  return {
    root,
    configFile: false as const,
    logLevel: "silent" as const,
    plugins: [openApiCodegenPlugin()],
    server: { host: "127.0.0.1", port: 0, strictPort: true },
    optimizeDeps: { noDiscovery: true, include: [] },
  };
}

test("regenerates before serving and after either service schema changes", async () => {
  const config = await setup();
  server = await createServer(config);
  await server.listen(0);
  const client = async () =>
    (await server!.transformRequest("/client.js"))?.code;
  expect(await client()).toContain('"initial"');

  for (const service of ["assistant", "gateway"]) {
    await writeFile(path.join(fixture, service, "openapi.yaml"), service);
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

test("queues schema changes that arrive during generation", async () => {
  const config = await setup();
  const generator = path.join(config.root, "generate.ts");
  await writeFile(
    generator,
    (await readFile(generator, "utf8")).replace(
      'await Bun.write("client.js",',
      `if (values[0] === "assistant" && values[1] === "initial") {
        await Bun.write("generation-started", "ready");
        while (!(await Bun.file("generation-release").exists())) {
          await Bun.sleep(10);
        }
      }
      await Bun.write("client.js",`,
    ),
  );
  server = await createServer(config);
  await server.listen(0);
  await writeFile(path.join(fixture, "assistant/openapi.yaml"), "assistant");
  const gateway = path.join(fixture, "gateway/openapi.yaml");
  let gatewayChanged = false;
  const onChange = (file: string) => {
    if (file === gateway) {
      gatewayChanged = true;
    }
  };
  server.watcher.on("change", onChange);
  try {
    await waitFor(
      async () => {
        expect(
          await Bun.file(path.join(config.root, "generation-started")).exists(),
        ).toBe(true);
      },
      { timeout: 10_000 },
    );
    await writeFile(gateway, "gateway");
    await waitFor(() => expect(gatewayChanged).toBe(true), { timeout: 10_000 });
  } finally {
    server.watcher.off("change", onChange);
    await writeFile(path.join(config.root, "generation-release"), "ready");
  }
  await waitFor(
    async () => {
      const code = (await server!.transformRequest("/client.js"))?.code;
      expect(code).toContain('"assistant"');
      expect(code).toContain('"gateway"');
    },
    { timeout: 10_000 },
  );
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

test("production builds do not invoke development code generation", async () => {
  const config = await setup();
  await writeFile(path.join(config.root, "generate.ts"), "process.exit(1)");
  await writeFile(path.join(config.root, "index.html"), "<p>Example app</p>");
  await build({ ...config, build: { write: false } });
});
