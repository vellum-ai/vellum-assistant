import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { escapeXmlAttr, escapeXmlContent } from "../util/xml.js";

const BUTTON_MASKS = {
  close: [0x201, 0x102, 0x084, 0x048, 0x030, 0x030, 0x048, 0x084, 0x102, 0x201],
  max: [0x3ff, 0x201, 0x201, 0x201, 0x201, 0x201, 0x201, 0x201, 0x201, 0x3ff],
  max_toggled: [
    0x3fc, 0x204, 0x27f, 0x241, 0x241, 0x241, 0x3c1, 0x041, 0x041, 0x07f,
  ],
  iconify: [0, 0, 0, 0, 0x3ff, 0x3ff, 0, 0, 0, 0],
};

function windowTheme(accentHex: string | null): string {
  const tint = (base: string, amount: number): string => {
    if (!accentHex || !/^#[\da-f]{6}$/i.test(accentHex)) {
      return base;
    }
    return (
      "#" +
      [1, 3, 5]
        .map((offset) => {
          const from = parseInt(base.slice(offset, offset + 2), 16);
          const to = parseInt(accentHex.slice(offset, offset + 2), 16);
          return Math.round(from + (to - from) * amount)
            .toString(16)
            .padStart(2, "0");
        })
        .join("")
    );
  };
  return `
border.width: 1
padding.width: 8
padding.height: 7
window.client.padding.width: 0
window.client.padding.height: 0
window.handle.width: 3
window.label.text.justify: Center
window.*.label.text.font: shadow=n
window.*.title.bg: Flat Solid
window.*.label.bg: Parentrelative
window.*.handle.bg: Flat Solid
window.*.grip.bg: Flat Solid
window.*.button.*.bg: Flat Solid
window.active.title.bg.color: #292930
window.active.border.color: ${tint("#4a4a54", 0.4)}
window.active.title.separator.color: ${tint("#202026", 0.4)}
window.active.label.text.color: #f0f0f4
window.active.handle.bg.color: #292930
window.active.grip.bg.color: #292930
window.active.button.*.bg.color: #292930
window.active.button.*.image.color: #d4d4dc
window.active.button.hover.bg.color: ${tint("#45454f", 0.22)}
window.active.button.pressed.bg.color: ${tint("#555561", 0.18)}
window.active.button.disabled.image.color: #62626e
window.active.button.close.hover.bg.color: #b64150
window.active.button.close.pressed.bg.color: #963442
window.inactive.title.bg.color: #232329
window.inactive.border.color: #36363f
window.inactive.title.separator.color: #202026
window.inactive.label.text.color: #a6a6b2
window.inactive.handle.bg.color: #232329
window.inactive.grip.bg.color: #232329
window.inactive.button.*.bg.color: #232329
window.inactive.button.*.image.color: #858592
window.inactive.button.hover.bg.color: #3b3b45
window.inactive.button.pressed.bg.color: #4a4a54
window.inactive.button.disabled.image.color: #565660
menu.border.width: 1
menu.border.color: #4a4a54
menu.title.bg: Flat Solid
menu.title.bg.color: #292930
menu.title.text.color: #f0f0f4
menu.title.text.font: shadow=n
menu.items.bg: Flat Solid
menu.items.bg.color: #232329
menu.items.text.color: #e6e6ee
menu.items.disabled.text.color: #858592
menu.items.active.bg: Flat Solid
menu.items.active.bg.color: #45454f
menu.items.active.text.color: #ffffff
menu.items.active.disabled.text.color: #a6a6b2
menu.separator.color: #45454f
osd.bg: Flat Solid
osd.bg.color: #292930
osd.border.color: #4a4a54
osd.label.text.color: #f0f0f4
`;
}

/** Keep Openbox bindings and placement rules while styling its decorations. */
export function writeDesktopWindowTheme(
  configDir: string,
  home?: string,
  accentHex: string | null = null,
): string {
  let source: string | undefined;
  let sourcePath = "";
  const candidates = [
    ...(home ? [join(home, ".config", "openbox", "rc.xml")] : []),
    "/etc/xdg/openbox/rc.xml",
  ];
  for (const path of candidates) {
    try {
      source = readFileSync(path, "utf8");
      sourcePath = path;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  if (!source || !/<theme>[^]*?<\/theme>/.test(source)) {
    throw new Error("Openbox theme configuration is unavailable");
  }
  const root = source.match(/<openbox_config\b[^>]*>/)?.[0];
  if (!root || /\bxml:base\s*=/.test(root)) {
    throw new Error("Openbox configuration requires its original base URI");
  }
  // Relative XIncludes keep resolving beside the source configuration.
  source = source.replace(root, () =>
    root.replace(
      "<openbox_config",
      `<openbox_config xml:base="${escapeXmlAttr(pathToFileURL(sourcePath).href)}"`,
    ),
  );
  const themeDir = join(configDir, "window-theme");
  mkdirSync(join(themeDir, "openbox-3"), { recursive: true });
  writeFileSync(
    join(themeDir, "openbox-3", "themerc"),
    windowTheme(accentHex).trimStart(),
  );
  for (const [name, rows] of Object.entries(BUTTON_MASKS)) {
    const bytes = rows.flatMap((row) => [row & 0xff, row >> 8]);
    writeFileSync(
      join(themeDir, "openbox-3", `${name}.xbm`),
      `#define button_width 10\n#define button_height 10\nstatic unsigned char button_bits[] = {\n${bytes.map((byte) => `0x${byte.toString(16)}`).join(",")}};\n`,
    );
  }
  const fonts = [
    "ActiveWindow",
    "InactiveWindow",
    "MenuHeader",
    "MenuItem",
    "ActiveOnScreenDisplay",
    "InactiveOnScreenDisplay",
  ].map(
    (place) =>
      `<font place="${place}"><name>sans</name><size>10</size><weight>normal</weight><slant>normal</slant></font>`,
  );
  const theme = `<theme>
  <name>${escapeXmlContent(themeDir)}</name>
  <titleLayout>LIMC</titleLayout>
  <keepBorder>yes</keepBorder>
  <animateIconify>yes</animateIconify>
  ${fonts.join("\n  ")}
</theme>`;
  const configPath = join(configDir, "window-manager.xml");
  writeFileSync(
    configPath,
    source.replace(/<theme>[^]*?<\/theme>/, () => theme),
  );
  return configPath;
}
