import { BrowserWindow, Menu, type WebContents } from "electron";

/**
 * Native right-click menu for images. The web app renders images as plain
 * `<img>` elements (chat bubbles, attachment previews, artifacts) with no
 * copy affordance of their own, and Electron shows no context menu unless
 * the app builds one — so this listener is the clipboard path for images.
 *
 * `copyImageAt` copies the decoded bitmap at the click position out of the
 * renderer, so it works uniformly for `blob:` object URLs and app-protocol
 * resources — no refetch, no CORS. The item is disabled when the image has
 * no decodable contents (e.g. a broken image glyph), matching Chromium's
 * own menu behavior.
 *
 * Pages that handle `contextmenu` themselves (`preventDefault()`) never
 * reach the WebContents `context-menu` event, so in-page custom menus are
 * unaffected by construction.
 */
export const installImageContextMenu = (contents: WebContents): void => {
  contents.on("context-menu", (_event, params) => {
    if (params.mediaType !== "image") {
      return;
    }
    const menu = Menu.buildFromTemplate([
      {
        label: "Copy Image",
        enabled: params.hasImageContents,
        click: () => contents.copyImageAt(params.x, params.y),
      },
    ]);
    // Anchor to the owning window rather than the focused one — a right-click
    // in an unfocused auxiliary window (popout, command palette) must pop its
    // menu there. `fromWebContents` is null for windowless contents; the
    // undefined fallback lets Electron use the focused window.
    menu.popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined });
  });
};
