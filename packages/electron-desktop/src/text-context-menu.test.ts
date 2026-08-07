import { describe, expect, mock, test } from "bun:test";

let listener: ((event: unknown, params: Record<string, unknown>) => void) | null = null;
let template: Array<Record<string, unknown>> = [];
const replaceMisspelling = mock((_word: string) => undefined);

mock.module("electron", () => ({
  BrowserWindow: { fromWebContents: () => null },
  Menu: {
    buildFromTemplate: (next: Array<Record<string, unknown>>) => {
      template = next;
      return { popup: () => undefined };
    },
  },
}));

const { installTextContextMenu } = await import("./text-context-menu");
const contents = {
  on: (_event: string, next: typeof listener) => {
    listener = next;
  },
  replaceMisspelling,
};

describe("installTextContextMenu", () => {
  test("offers spelling suggestions and editable text roles", () => {
    installTextContextMenu(contents as never);
    listener?.({}, {
      isEditable: true,
      selectionText: "teh",
      mediaType: "none",
      misspelledWord: "teh",
      dictionarySuggestions: ["the"],
    });

    expect(template[0]?.label).toBe("the");
    (template[0]?.click as (() => void) | undefined)?.();
    expect(replaceMisspelling).toHaveBeenCalledWith("the");
    expect(template.some((item) => item.role === "pasteAndMatchStyle")).toBe(true);
  });

  test("does not replace the image context menu", () => {
    template = [];
    listener?.({}, { isEditable: true, mediaType: "image" });
    expect(template).toEqual([]);
  });
});
