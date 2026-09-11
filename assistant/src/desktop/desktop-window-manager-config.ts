import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Openbox supplies the standard move, resize, focus and Alt-Tab bindings. */
export function writeDesktopWindowManagerConfig(configDir: string): string {
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, "openbox.xml");
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <desktops>
    <number>1</number>
    <firstdesk>1</firstdesk>
    <popupTime>0</popupTime>
  </desktops>
  <menu><manageDesktops>no</manageDesktops></menu>
  <applications>
    <application class="*"><desktop>1</desktop></application>
  </applications>
</openbox_config>
`,
  );
  return path;
}
