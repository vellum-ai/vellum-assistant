import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import JSZip from "jszip";

import { PptxPreview } from "@/domains/chat/components/local-file/preview/pptx-preview";

const SLIDE_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const RELATIONSHIPS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`;

function slideXml(shapes: string): string {
  return `<p:sld ${SLIDE_NS}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;
}

const TITLE_SHAPE = `<p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Roadmap</a:t></a:r></a:p></p:txBody></p:sp>`;

const BODY_SHAPE = `<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Ship it</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>Then measure</a:t></a:r></a:p></p:txBody></p:sp>`;

const PICTURE = `<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>`;

async function pptxBlob(): Promise<Blob> {
  const zip = new JSZip();
  zip.file(
    "ppt/slides/slide1.xml",
    slideXml(`${TITLE_SHAPE}${BODY_SHAPE}${PICTURE}`),
  );
  zip.file("ppt/slides/_rels/slide1.xml.rels", RELATIONSHIPS);
  zip.file(
    "ppt/slides/slide2.xml",
    slideXml(
      `<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Thanks</a:t></a:r></a:p></p:txBody></p:sp>`,
    ),
  );
  zip.file("ppt/media/image1.png", PNG_BYTES);
  return zip.generateAsync({ type: "blob" });
}

afterEach(() => {
  cleanup();
});

describe("PptxPreview", () => {
  test("shows a placeholder until the deck is parsed", async () => {
    render(<PptxPreview blob={await pptxBlob()} filename="deck.pptx" />);

    expect(screen.getByRole("status", { name: "Loading preview" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Slide 1")).toBeTruthy());
  });

  test("renders one card per slide with title, body, and images", async () => {
    const { container } = render(
      <PptxPreview blob={await pptxBlob()} filename="deck.pptx" />,
    );

    expect(await screen.findByText("Slide 1")).toBeTruthy();
    expect(screen.getByText("Slide 2")).toBeTruthy();
    expect(container.querySelectorAll("section")).toHaveLength(2);

    const title = screen.getByRole("heading", { name: "Roadmap" });
    expect(title.tagName).toBe("H3");

    // The second body paragraph sits at outline level 1, so it is indented.
    const indented = screen.getByText("Then measure").closest("p");
    expect(indented?.getAttribute("style")).toContain("margin-left");
    expect(screen.getByText("Ship it").closest("p")?.getAttribute("style")).toBe(
      "margin-left: 0rem;",
    );

    const image = container.querySelector("img");
    expect(image?.getAttribute("src")?.startsWith("blob:")).toBe(true);
    expect(image?.getAttribute("class")).toContain("object-contain");
  });

  test("a package it cannot read falls back to a named error state", async () => {
    render(
      <PptxPreview
        blob={new Blob([new Uint8Array([1, 2, 3, 4])])}
        filename="deck.pptx"
      />,
    );

    expect(await screen.findByText("Can't preview this file")).toBeTruthy();
    expect(screen.getByText("deck.pptx")).toBeTruthy();
  });

  test("a deck whose slides hold nothing renders the empty state", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", slideXml(""));

    render(
      <PptxPreview
        blob={await zip.generateAsync({ type: "blob" })}
        filename="blank.pptx"
      />,
    );

    expect(
      await screen.findByText("Nothing to preview in this file"),
    ).toBeTruthy();
  });

  test("image object URLs are revoked on unmount", async () => {
    const revoke = spyOn(URL, "revokeObjectURL");
    revoke.mockClear();

    const { container, unmount } = render(
      <PptxPreview blob={await pptxBlob()} filename="deck.pptx" />,
    );

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const source = container.querySelector("img")!.getAttribute("src")!;

    unmount();

    expect(revoke).toHaveBeenCalledWith(source);
    revoke.mockRestore();
  });
});
