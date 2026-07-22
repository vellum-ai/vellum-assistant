import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { WebContents } from "electron";

// Capture the template each Menu.buildFromTemplate call receives and the
// popup options, so tests can assert the menu shape and anchoring without a
// real Electron runtime.
type TemplateItem = {
  label: string;
  enabled?: boolean;
  click?: () => void;
};

const fakeWindow = { __kind: "window" };
const popupMock = mock((_opts: unknown) => undefined);
const buildFromTemplateMock = mock((_template: TemplateItem[]) => ({
  popup: popupMock,
}));
const fromWebContentsMock = mock((_contents: unknown): unknown => fakeWindow);
mock.module("electron", () => ({
  Menu: { buildFromTemplate: buildFromTemplateMock },
  BrowserWindow: { fromWebContents: fromWebContentsMock },
}));

const { installImageContextMenu } = await import("./image-context-menu");

type ContextMenuListener = (
  event: unknown,
  params: Record<string, unknown>,
) => void;

// Minimal WebContents stand-in: records `context-menu` listeners and exposes
// a trigger so tests can simulate a right-click with arbitrary params.
const makeContents = () => {
  const listeners: ContextMenuListener[] = [];
  const copyImageAtMock = mock((_x: number, _y: number) => undefined);
  const contents = {
    on: (event: string, listener: ContextMenuListener) => {
      if (event === "context-menu") {
        listeners.push(listener);
      }
      return contents;
    },
    copyImageAt: copyImageAtMock,
  };
  return {
    contents: contents as unknown as WebContents,
    copyImageAtMock,
    rightClick: (params: Record<string, unknown>) => {
      for (const listener of listeners) {
        listener({}, params);
      }
    },
  };
};

const imageParams = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  mediaType: "image",
  hasImageContents: true,
  x: 120,
  y: 45,
  ...overrides,
});

const lastTemplate = (): TemplateItem[] =>
  buildFromTemplateMock.mock.calls.at(-1)![0];

beforeEach(() => {
  popupMock.mockClear();
  buildFromTemplateMock.mockClear();
  fromWebContentsMock.mockClear();
  fromWebContentsMock.mockReturnValue(fakeWindow);
});

describe("installImageContextMenu", () => {
  test("right-clicking an image pops a single-item Copy Image menu", () => {
    const { contents, rightClick } = makeContents();
    installImageContextMenu(contents);

    rightClick(imageParams());

    expect(buildFromTemplateMock).toHaveBeenCalledTimes(1);
    const template = lastTemplate();
    expect(template).toHaveLength(1);
    expect(template[0]!.label).toBe("Copy Image");
    expect(template[0]!.enabled).toBe(true);
    expect(popupMock).toHaveBeenCalledTimes(1);
  });

  test("clicking Copy Image copies the bitmap at the click position", () => {
    const { contents, copyImageAtMock, rightClick } = makeContents();
    installImageContextMenu(contents);

    rightClick(imageParams({ x: 300, y: 88 }));
    lastTemplate()[0]!.click!();

    expect(copyImageAtMock).toHaveBeenCalledTimes(1);
    expect(copyImageAtMock).toHaveBeenCalledWith(300, 88);
  });

  test("non-image right-clicks show no menu", () => {
    const { contents, rightClick } = makeContents();
    installImageContextMenu(contents);

    rightClick(imageParams({ mediaType: "none" }));
    rightClick(imageParams({ mediaType: "video" }));

    expect(buildFromTemplateMock).not.toHaveBeenCalled();
    expect(popupMock).not.toHaveBeenCalled();
  });

  test("Copy Image is disabled for an image with no decodable contents", () => {
    const { contents, rightClick } = makeContents();
    installImageContextMenu(contents);

    rightClick(imageParams({ hasImageContents: false }));

    expect(lastTemplate()[0]!.enabled).toBe(false);
  });

  test("the menu anchors to the owning window", () => {
    const { contents, rightClick } = makeContents();
    installImageContextMenu(contents);

    rightClick(imageParams());

    expect(fromWebContentsMock).toHaveBeenCalledWith(contents);
    expect(popupMock).toHaveBeenCalledWith({ window: fakeWindow });
  });

  test("windowless contents fall back to the focused window", () => {
    fromWebContentsMock.mockReturnValue(null);
    const { contents, rightClick } = makeContents();
    installImageContextMenu(contents);

    rightClick(imageParams());

    expect(popupMock).toHaveBeenCalledWith({ window: undefined });
  });
});
