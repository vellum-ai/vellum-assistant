import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { DOMParser } from "@xmldom/xmldom";

import { writeDesktopWindowManagerConfig } from "./desktop-window-manager-config.js";

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
});
