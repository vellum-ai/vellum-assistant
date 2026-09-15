import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type Document,
  DOMParser,
  type Element,
  XMLSerializer,
} from "@xmldom/xmldom";

import { getLogger } from "../util/logger.js";

const log = getLogger("desktop-window-config");

const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XINCLUDE_NAMESPACE = "http://www.w3.org/2001/XInclude";

const WORKSPACE_MENUS = new Set([
  "client-list-menu",
  "client-list-combined-menu",
]);
const WORKSPACE_ACTION =
  /^(GoToDesktop|SendToDesktop.*|AddDesktop.*|RemoveDesktop.*|Desktop(?:Next|Previous|Left|Right|Up|Down|Last)?|ToggleOmnipresent)$/i;

export function writeDesktopWindowManagerConfig(
  configDir: string,
  home = homedir(),
  sourcePath?: string,
): string {
  const searchDirs = [join(home, ".config", "openbox"), "/etc/xdg/openbox"];
  const source = readConfig(sourcePath ?? "rc.xml", searchDirs);
  if (!source) {
    throw new Error("Desktop window manager config is missing: rc.xml");
  }
  try {
    return writeManagedConfig(configDir, home, searchDirs, source);
  } catch (err) {
    log.warn(
      { err },
      "Desktop workspace config could not be adapted; preserving the existing Openbox config",
    );
    return source.path;
  }
}

function writeManagedConfig(
  configDir: string,
  home: string,
  searchDirs: string[],
  source: { path: string; contents: string },
): string {
  const config = parseXml(source.contents, source.path);
  const root = config.documentElement!;
  for (const section of ["desktops", "mouse", "menu", "applications"]) {
    child(root, section);
  }
  mkdirSync(configDir, { recursive: true });
  const copies = new Map<string, string>();
  function copyConfig(source: { path: string; contents: string }): string {
    const existing = copies.get(source.path);
    if (existing) {
      return existing;
    }
    const path = join(configDir, `openbox-include-${copies.size}.xml`);
    copies.set(source.path, path);
    const document = parseXml(source.contents, source.path);
    adaptReferences(document);
    writeFileSync(path, new XMLSerializer().serializeToString(document));
    return path;
  }
  function adaptReferences(document: Document): void {
    removeWorkspaceControls(document);
    configureWorkspaceSections(document);
    for (const include of Array.from(
      document.getElementsByTagNameNS(XINCLUDE_NAMESPACE, "include"),
    )) {
      if (include.getAttribute("parse") === "text") {
        continue;
      }
      const url = new URL(include.getAttribute("href") ?? "", xmlBase(include));
      const included = readConfig(fileURLToPath(url), []);
      if (included) {
        include.setAttribute("href", pathToFileURL(copyConfig(included)).href);
      }
    }
    for (const file of Array.from(
      document.getElementsByTagNameNS("*", "file"),
    )) {
      if ((file.parentNode as Element | null)?.localName !== "menu") {
        continue;
      }
      const name = file.textContent?.trim();
      if (!name) {
        continue;
      }
      const menuSource = readConfig(
        name.startsWith("~/") ? join(home, name.slice(2)) : name,
        searchDirs,
      );
      if (menuSource) {
        file.textContent = copyConfig(menuSource);
      }
    }
  }
  adaptReferences(config);
  const path = join(configDir, "openbox.xml");
  writeFileSync(path, new XMLSerializer().serializeToString(config));
  return path;
}

function configureWorkspaceSections(document: Document): void {
  for (const desktops of Array.from(
    document.getElementsByTagNameNS("*", "desktops"),
  )) {
    child(desktops, "number").textContent = "1";
    child(desktops, "firstdesk").textContent = "1";
    child(desktops, "popupTime").textContent = "0";
  }
  for (const mouse of Array.from(
    document.getElementsByTagNameNS("*", "mouse"),
  )) {
    child(mouse, "screenEdgeWarpTime").textContent = "0";
  }
  for (const menu of Array.from(document.getElementsByTagNameNS("*", "menu"))) {
    if (
      !menu.hasAttribute("id") &&
      (menu.parentNode as Element | null)?.localName !== "action"
    ) {
      child(menu, "manageDesktops").textContent = "no";
    }
  }
  for (const applications of Array.from(
    document.getElementsByTagNameNS("*", "applications"),
  )) {
    // The last matching rule also covers windows restored with stale assignments.
    const application = document.createElementNS(
      applications.namespaceURI,
      "application",
    );
    application.setAttribute("class", "*");
    child(application, "desktop").textContent = "1";
    applications.appendChild(application);
  }
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

function parseXml(contents: string, sourcePath: string): Document {
  const document = new DOMParser({
    onError: (level, message) => {
      if (level !== "warning") {
        throw new Error(message);
      }
    },
  }).parseFromString(contents, "application/xml");
  const root = document.documentElement!;
  root.setAttributeNS(
    XML_NAMESPACE,
    "xml:base",
    new URL(
      root.getAttributeNS(XML_NAMESPACE, "base") ?? "",
      pathToFileURL(sourcePath),
    ).href,
  );
  return document;
}

function xmlBase(element: Element): string {
  const ancestors: Element[] = [];
  for (
    let node: Element | null = element;
    node;
    node = node.parentNode?.nodeType === 1 ? (node.parentNode as Element) : null
  ) {
    ancestors.unshift(node);
  }
  let base = "";
  for (const ancestor of ancestors) {
    const value = ancestor.getAttributeNS(XML_NAMESPACE, "base");
    if (value) {
      base = base ? new URL(value, base).href : value;
    }
  }
  return base;
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
