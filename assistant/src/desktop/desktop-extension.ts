import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ProvisionDesktopExtensionResultSchema } from "@vellumai/gateway-client";

import { getGatewayInternalBaseUrl } from "../config/env.js";
import { ipcCallPersistentValidated } from "../ipc/gateway-validated-call.js";
import { getProtectedDir } from "../util/platform.js";
import { desktopBrowserBridge } from "./desktop-browser-bridge.js";

export const DESKTOP_EXTENSION_VERSION = "1.0.2";
let artifact: { id: string; crx: Buffer; gateway: string } | undefined;
let installed: Promise<void> | undefined;

export function desktopExtensionAsset(kind: "update" | "package"): {
  data: string;
  contentType: string;
} {
  if (!artifact) {
    throw new Error("Desktop extension is not installed");
  }
  if (kind === "package") {
    return {
      data: artifact.crx.toString("base64"),
      contentType: "application/x-chrome-extension",
    };
  }
  const url = `${artifact.gateway}/v1/desktop/browser/package`
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${artifact.id}"><updatecheck codebase="${url}" version="${DESKTOP_EXTENSION_VERSION}" /></app></gupdate>`;
  return {
    data: Buffer.from(xml).toString("base64"),
    contentType: "application/xml",
  };
}

export function ensureDesktopExtension(browser: {
  chromePath: string;
  profileDir: string;
}): Promise<void> {
  installed ??= install(browser).catch((err) => {
    installed = undefined;
    throw err;
  });
  return installed;
}

async function install(browser: {
  chromePath: string;
  profileDir: string;
}): Promise<void> {
  const root = join(getProtectedDir(), "desktop-extension");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(tmpdir(), "vellum-desktop-extension-"));
  try {
    const source = fileURLToPath(
      new URL(
        "../../../clients/chrome-extension/background/managed-desktop-worker.ts",
        import.meta.url,
      ),
    );
    const build = await Bun.build({
      entrypoints: [source],
      target: "browser",
      format: "esm",
      outdir: stage,
      naming: "worker.js",
      minify: true,
    });
    if (!build.success) {
      throw new Error("Could not build the managed desktop extension");
    }
    await writeFile(
      join(stage, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Vellum Assistant Desktop",
        version: DESKTOP_EXTENSION_VERSION,
        minimum_chrome_version: "125",
        permissions: ["alarms", "debugger", "nativeMessaging", "tabs"],
        background: { service_worker: "worker.js", type: "module" },
      }),
    );
    const zipPath = join(root, "extension.zip");
    const zip = Bun.spawn(
      [
        "python3",
        "-c",
        "import pathlib,sys,zipfile\nwith zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as z:\n for p in sorted(pathlib.Path(sys.argv[1]).iterdir()):\n  z.write(p,p.name)",
        stage,
        zipPath,
      ],
      { windowsHide: true, stdout: "ignore", stderr: "ignore" },
    );
    if ((await zip.exited) !== 0) {
      throw new Error("Could not package the managed desktop extension");
    }
    const signed = await ipcCallPersistentValidated(
      "provision_desktop_extension",
      { zip: (await readFile(zipPath)).toString("base64") },
      ProvisionDesktopExtensionResultSchema,
    );
    await rm(zipPath);
    const gateway = getGatewayInternalBaseUrl().replace(/\/$/, "");
    const gatewayUrl = new URL(gateway);
    if (
      !["http:", "https:"].includes(gatewayUrl.protocol) ||
      gatewayUrl.username ||
      gatewayUrl.password ||
      gatewayUrl.search ||
      gatewayUrl.hash
    ) {
      throw new Error("Invalid internal gateway URL for desktop browser");
    }
    artifact = {
      id: signed.id,
      crx: Buffer.from(signed.crx, "base64"),
      gateway,
    };
    const native = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL("./desktop-native-host.ts", import.meta.url)),
      ],
      target: "bun",
      format: "esm",
      outdir: root,
      naming: "native-host.js",
    });
    if (!native.success) {
      throw new Error("Could not build the desktop native host");
    }
    const config = join(root, "connection.json");
    await writeFile(
      config,
      JSON.stringify({
        token: desktopBrowserBridge.start(signed.token),
        gateway,
        extensionId: signed.id,
        version: DESKTOP_EXTENSION_VERSION,
        ...browser,
      }),
      { mode: 0o600 },
    );
    const launcher = join(root, "native-host");
    const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
    await writeFile(
      launcher,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, "native-host.js"))} ${quote(config)} "$@"\n`,
      { mode: 0o700 },
    );
    await chmod(launcher, 0o700);
    const nativeManifest =
      "/etc/opt/chrome/native-messaging-hosts/ai.vellum.desktop.json";
    await mkdir(dirname(nativeManifest), { recursive: true });
    await writeFile(
      nativeManifest,
      JSON.stringify({
        name: "ai.vellum.desktop",
        description: "Vellum managed desktop browser",
        path: launcher,
        type: "stdio",
        allowed_origins: [`chrome-extension://${signed.id}/`],
      }),
    );
    const policy =
      "/etc/opt/chrome/policies/managed/vellum-desktop-extension.json";
    await mkdir(dirname(policy), { recursive: true });
    await writeFile(
      policy,
      JSON.stringify({
        ExtensionSettings: {
          [signed.id]: {
            installation_mode: "force_installed",
            update_url: `${gateway}/v1/desktop/browser/update`,
            override_update_url: true,
          },
        },
      }),
    );
  } catch (err) {
    artifact = undefined;
    desktopBrowserBridge.stop();
    throw err;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
