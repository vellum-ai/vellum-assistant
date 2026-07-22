import { BrowserWindow, Menu, type MenuItemConstructorOptions, type WebContents } from "electron";

export const installTextContextMenu = (contents: WebContents): void => {
  contents.on("context-menu", (_event, params) => {
    if (!params.isEditable && !params.selectionText) {
      return;
    }

    if (params.mediaType === "image") {
      return;
    }

    const template: MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      if (params.dictionarySuggestions && params.dictionarySuggestions.length > 0) {
        for (const suggestion of params.dictionarySuggestions) {
          template.push({
            label: suggestion,
            click: () => contents.replaceMisspelling(suggestion),
          });
        }
      } else {
        template.push({
          label: "No Guesses Found",
          enabled: false,
        });
      }
      template.push({ type: "separator" });
    }

    if (params.isEditable) {
      template.push({ role: "undo" });
      template.push({ role: "redo" });
      template.push({ type: "separator" });
      template.push({ role: "cut" });
    }

    if (params.isEditable || params.selectionText) {
      template.push({ role: "copy" });
    }

    if (params.isEditable) {
      template.push({ role: "paste" });
      template.push({ role: "pasteAndMatchStyle" });
    }

    template.push({ role: "selectAll" });

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined });
  });
};
