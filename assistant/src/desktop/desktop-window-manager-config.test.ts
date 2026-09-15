import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";

import { DOMParser } from "@xmldom/xmldom";

import { writeDesktopWindowManagerConfig } from "./desktop-window-manager-config.js";
import { writeDesktopWindowTheme } from "./desktop-window-theme.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapts existing settings without removing window controls, application menus or originals", () => {
  const home = mkdtempSync(join(tmpdir(), "desktop-window-config-"));
  roots.push(home);
  const sourceDir = join(home, ".config", "openbox");
  mkdirSync(sourceDir, { recursive: true });
  const source = `<openbox_config xmlns="http://openbox.org/3.4/rc">
    <theme><name>Custom theme</name><titleLayout>NLIMC</titleLayout></theme>
    <desktops><number>4</number><firstdesk>3</firstdesk></desktops>
    <keyboard>
      <keybind key="A-Tab"><action name="NextWindow"/></keybind>
      <keybind key="C-A-Right"><action name="GoToDesktop"><to>right</to></action></keybind>
      <keybind key="W-d"><action name="ShowDesktop"/></keybind>
    </keyboard>
    <mouse><context name="Desktop">
      <mousebind button="Up" action="Click"><action name="GoToDesktop"><to>previous</to></action></mousebind>
      <mousebind button="Middle" action="Press"><action name="ShowMenu"><menu>client-list-combined-menu</menu></action></mousebind>
      <mousebind button="Right" action="Press"><action name="ShowMenu"><menu>root-menu</menu></action></mousebind>
    </context><context name="Titlebar">
      <mousebind button="Left" action="Drag"><action name="Move"/></mousebind>
    </context></mouse>
    <menu><file>menu.xml</file><file>/missing/optional-menu.xml</file></menu>
    <applications><application class="XTerm"><desktop>4</desktop><maximized>yes</maximized></application></applications>
  </openbox_config>`;
  const menu = `<openbox_menu xmlns="http://openbox.org/3.4/menu"><menu id="root-menu" label="Menu">
    <item label="Terminal"><action name="Execute"><command>xterm</command></action></item>
    <menu id="client-list-menu" label="Desktops"/>
  </menu></openbox_menu>`;
  writeFileSync(join(sourceDir, "rc.xml"), source);
  writeFileSync(join(sourceDir, "menu.xml"), menu);
  const configDir = join(home, "generated");
  const path = writeDesktopWindowManagerConfig(configDir, home);
  const first = readFileSync(path, "utf8");
  const parsed = new DOMParser().parseFromString(first, "application/xml");
  const actions = Array.from(parsed.getElementsByTagName("action"));
  expect(actions.map((action) => action.getAttribute("name"))).toEqual([
    "NextWindow",
    "ShowDesktop",
    "ShowMenu",
    "Move",
  ]);
  expect(actions[2]?.textContent).toBe("root-menu");
  expect(parsed.getElementsByTagName("theme")[0]?.textContent).toBe(
    "Custom themeNLIMC",
  );
  const rules = Array.from(parsed.getElementsByTagName("application"));
  expect(rules[0]?.getElementsByTagName("maximized")[0]?.textContent).toBe(
    "yes",
  );
  expect(rules.at(-1)?.getAttribute("class")).toBe("*");
  expect(rules.at(-1)?.getElementsByTagName("desktop")[0]?.textContent).toBe(
    "1",
  );
  const generatedMenu = readFileSync(
    parsed.getElementsByTagName("file")[0]!.textContent!,
    "utf8",
  );
  expect(parsed.getElementsByTagName("file")[1]?.textContent).toBe(
    "/missing/optional-menu.xml",
  );
  expect(generatedMenu).toContain('label="Terminal"');
  expect(generatedMenu).not.toContain('id="client-list-menu"');
  expect(readFileSync(join(sourceDir, "rc.xml"), "utf8")).toBe(source);
  expect(readFileSync(join(sourceDir, "menu.xml"), "utf8")).toBe(menu);
  writeDesktopWindowManagerConfig(configDir, home);
  expect(readFileSync(path, "utf8")).toBe(first);
  const themed = writeDesktopWindowTheme(configDir, home);
  writeDesktopWindowManagerConfig(configDir, home, themed);
  const composed = new DOMParser().parseFromString(
    readFileSync(path, "utf8"),
    "application/xml",
  );
  expect(
    composed.getElementsByTagName("theme")[0]?.getElementsByTagName("name")[0]
      ?.textContent,
  ).toBe(join(configDir, "window-theme"));
  expect(composed.documentElement?.getAttribute("xml:base")).toContain(
    "/.config/openbox/rc.xml",
  );
  expect(composed.getElementsByTagName("action").length).toBe(actions.length);
  expect(readFileSync(join(sourceDir, "rc.xml"), "utf8")).toBe(source);
});

test("adapts nested XIncludes while preserving window actions, lookup bases and source files", () => {
  const home = mkdtempSync(join(tmpdir(), "desktop-window-includes-"));
  roots.push(home);
  const sourceDir = join(home, ".config", "openbox");
  mkdirSync(join(sourceDir, "bindings", "nested"), { recursive: true });
  const sources = {
    "rc.xml": `<openbox_config xmlns="http://openbox.org/3.4/rc" xmlns:xi="http://www.w3.org/2001/XInclude">
      <theme><name>Custom</name></theme>
      <xi:include href="bindings/keyboard.xml"/>
      <xi:include href="sections.xml" xpointer="xpointer(/sections/*)"/>
      <menu><file>menu.xml</file></menu>
    </openbox_config>`,
    "sections.xml": `<sections>
      <desktops><number>4</number><firstdesk>3</firstdesk></desktops>
      <mouse><screenEdgeWarpTime>400</screenEdgeWarpTime></mouse>
      <menu><manageDesktops>yes</manageDesktops><file>menu.xml</file></menu>
      <applications><application class="XTerm"><desktop>4</desktop><maximized>yes</maximized></application></applications>
    </sections>`,
    "bindings/keyboard.xml": `<keyboard xmlns="http://openbox.org/3.4/rc" xmlns:xi="http://www.w3.org/2001/XInclude" xml:base="nested/">
      <keybind key="A-Tab"><action name="NextWindow"/></keybind>
      <keybind key="C-A-Right"><action name="GoToDesktop"/></keybind>
      <xi:include href="more.xml" xpointer="xpointer(/bindings/keybind)"/>
    </keyboard>`,
    "bindings/nested/more.xml": `<bindings>
      <keybind key="A-F4"><action name="Close"/></keybind>
      <keybind key="C-A-Plus"><action name="AddDesktopLast"/></keybind>
    </bindings>`,
    "menu.xml": `<openbox_menu xmlns:xi="http://www.w3.org/2001/XInclude">
      <menu id="root-menu"><xi:include href="menu-items.xml"/></menu>
    </openbox_menu>`,
    "menu-items.xml": `<menu id="apps">
      <item label="Terminal"><action name="Execute"><command>xterm</command></action></item>
      <item label="Workspaces"><action name="ShowMenu"><menu>client-list-menu</menu></action></item>
    </menu>`,
  };
  for (const [name, contents] of Object.entries(sources)) {
    writeFileSync(join(sourceDir, name), contents);
  }
  const configDir = join(home, "generated");
  const readXml = (path: string) =>
    new DOMParser().parseFromString(
      readFileSync(path, "utf8"),
      "application/xml",
    );
  const config = readXml(
    writeDesktopWindowManagerConfig(
      configDir,
      home,
      writeDesktopWindowTheme(configDir, home),
    ),
  );
  const include = (document: ReturnType<typeof readXml>) =>
    document.getElementsByTagNameNS(
      "http://www.w3.org/2001/XInclude",
      "include",
    )[0]!;
  const sections = readXml(
    fileURLToPath(
      config
        .getElementsByTagNameNS(
          "http://www.w3.org/2001/XInclude",
          "include",
        )[1]!
        .getAttribute("href")!,
    ),
  );
  expect(sections.getElementsByTagName("number")[0]!.textContent).toBe("1");
  expect(sections.getElementsByTagName("firstdesk")[0]!.textContent).toBe("1");
  expect(
    sections.getElementsByTagName("screenEdgeWarpTime")[0]!.textContent,
  ).toBe("0");
  expect(sections.getElementsByTagName("manageDesktops")[0]!.textContent).toBe(
    "no",
  );
  const rules = Array.from(sections.getElementsByTagName("application"));
  expect(rules[0]!.getElementsByTagName("maximized")[0]!.textContent).toBe(
    "yes",
  );
  expect(rules.at(-1)!.getAttribute("class")).toBe("*");
  expect(rules.at(-1)!.getElementsByTagName("desktop")[0]!.textContent).toBe(
    "1",
  );
  const keyboard = readXml(
    fileURLToPath(include(config).getAttribute("href")!),
  );
  expect(keyboard.toString()).toContain('name="NextWindow"');
  expect(keyboard.toString()).not.toContain('name="GoToDesktop"');
  expect(include(keyboard).getAttribute("xpointer")).toBe(
    "xpointer(/bindings/keybind)",
  );
  const nested = readXml(
    fileURLToPath(include(keyboard).getAttribute("href")!),
  );
  expect(nested.toString()).toContain('name="Close"');
  expect(nested.toString()).not.toContain('name="AddDesktopLast"');
  const menu = readXml(config.getElementsByTagName("file")[0]!.textContent!);
  const items = readXml(fileURLToPath(include(menu).getAttribute("href")!));
  expect(items.toString()).toContain("xterm");
  expect(items.toString()).not.toContain("client-list-menu");
  for (const [name, contents] of Object.entries(sources)) {
    expect(readFileSync(join(sourceDir, name), "utf8")).toBe(contents);
  }
});

for (const entityLocation of ["config", "menu"] as const) {
  test(`preserves valid ${entityLocation} DTD entities for Openbox when adaptation is unsupported`, () => {
    const home = mkdtempSync(join(tmpdir(), "desktop-window-entities-"));
    roots.push(home);
    const sourceDir = join(home, ".config", "openbox");
    mkdirSync(sourceDir, { recursive: true });
    const configPath = join(sourceDir, "rc.xml");
    const config =
      entityLocation === "config"
        ? `<!DOCTYPE openbox_config [<!ENTITY theme "Custom">]><openbox_config><theme><name>&theme;</name></theme></openbox_config>`
        : `<openbox_config><menu><file>menu.xml</file></menu></openbox_config>`;
    const menu = `<!DOCTYPE openbox_menu [<!ENTITY terminal "xterm">]><openbox_menu><menu id="root-menu"><item label="Terminal"><action name="Execute"><command>&terminal;</command></action></item></menu></openbox_menu>`;
    writeFileSync(configPath, config);
    writeFileSync(join(sourceDir, "menu.xml"), menu);
    const path = writeDesktopWindowManagerConfig(join(home, "generated"), home);
    expect(path).toBe(configPath);
    expect(readFileSync(path, "utf8")).toBe(config);
    expect(readFileSync(join(sourceDir, "menu.xml"), "utf8")).toBe(menu);
  });
}
