import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import {
  type Document,
  DOMParser,
  type Element,
  XMLSerializer,
} from "@xmldom/xmldom";

const WORKSPACE_MENUS = new Set([
  "client-list-menu",
  "client-list-combined-menu",
]);
const WORKSPACE_ACTION =
  /^(GoToDesktop|SendToDesktop.*|AddDesktop.*|RemoveDesktop.*|Desktop(?:Next|Previous|Left|Right|Up|Down|Last)?|ToggleOmnipresent)$/i;

export function writeDesktopWindowManagerConfig(
  configDir: string,
  home = homedir(),
): string {
  const searchDirs = [join(home, ".config", "openbox"), "/etc/xdg/openbox"];
  const source = readConfig("rc.xml", searchDirs);
  if (!source) {
    throw new Error("Desktop window manager config is missing: rc.xml");
  }
  const config = parseXml(source.contents);
  const root = config.documentElement!;
  const desktops = child(root, "desktops");
  child(desktops, "number").textContent = "1";
  child(desktops, "firstdesk").textContent = "1";
  child(desktops, "popupTime").textContent = "0";
  const mouse = root.getElementsByTagNameNS("*", "mouse")[0];
  if (mouse) {
    child(mouse, "screenEdgeWarpTime").textContent = "0";
  }
  child(child(root, "menu"), "manageDesktops").textContent = "no";
  // The last matching rule also covers windows restored with stale assignments.
  const application = config.createElementNS(root.namespaceURI, "application");
  application.setAttribute("class", "*");
  child(application, "desktop").textContent = "1";
  child(root, "applications").appendChild(application);
  removeWorkspaceControls(config);
  mkdirSync(configDir, { recursive: true });
  const menuFiles = Array.from(
    child(root, "menu").getElementsByTagNameNS("*", "file"),
  );
  for (const [index, file] of menuFiles.entries()) {
    const name = file.textContent?.trim();
    if (!name) {
      continue;
    }
    const menuSource = readConfig(
      name.startsWith("~/") ? join(home, name.slice(2)) : name,
      [dirname(source.path), ...searchDirs],
    );
    if (!menuSource) {
      continue;
    }
    const menu = parseXml(menuSource.contents);
    removeWorkspaceControls(menu);
    const menuPath = join(configDir, `openbox-menu-${index}.xml`);
    writeFileSync(menuPath, new XMLSerializer().serializeToString(menu));
    file.textContent = menuPath;
  }
  const path = join(configDir, "openbox.xml");
  writeFileSync(path, new XMLSerializer().serializeToString(config));
  return path;
}

function readConfig(name: string, directories: string[]) {
  for (const path of isAbsolute(name)
    ? [name]
    : directories.map((dir) => join(dir, name))) {
    try {
      return { path, contents: readFileSync(path, "utf8") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  return null;
}

function parseXml(contents: string): Document {
  return new DOMParser({
    onError: (level, message) => {
      if (level !== "warning") {
        throw new Error(message);
      }
    },
  }).parseFromString(contents, "application/xml");
}

function child(parent: Element, name: string): Element {
  const existing = Array.from(parent.childNodes).find(
    (node): node is Element =>
      node.nodeType === 1 && (node as Element).localName === name,
  );
  if (existing) {
    return existing;
  }
  const element = parent.ownerDocument!.createElementNS(
    parent.namespaceURI,
    name,
  );
  parent.appendChild(element);
  return element;
}

function removeWorkspaceControls(document: Document): void {
  for (const menu of Array.from(document.getElementsByTagNameNS("*", "menu"))) {
    if (WORKSPACE_MENUS.has(menu.getAttribute("id") ?? "")) {
      menu.parentNode?.removeChild(menu);
    }
  }
  for (const action of Array.from(
    document.getElementsByTagNameNS("*", "action"),
  )) {
    const name = action.getAttribute("name") ?? "";
    const menu = action
      .getElementsByTagNameNS("*", "menu")[0]
      ?.textContent?.trim();
    if (
      WORKSPACE_ACTION.test(name) ||
      (name.toLowerCase() === "showmenu" && menu && WORKSPACE_MENUS.has(menu))
    ) {
      action.parentNode?.removeChild(action);
    }
  }
}
