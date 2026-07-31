import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import JSZip from "jszip";

import { DocxPreview } from "@/domains/chat/components/local-file/preview/docx-preview";

const WORD_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const RELATIONSHIPS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`;

const NUMBERING = `<w:numbering ${WORD_NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

const BODY =
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly report</w:t></w:r></w:p>` +
  `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Revenue </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>grew</w:t></w:r></w:p>` +
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>EMEA up 12%</w:t></w:r></w:p>` +
  `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Total</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
  `<w:p><w:r><w:drawing><a:blip r:embed="rId4"/></w:drawing></w:r></w:p>`;

async function docxBlob(): Promise<Blob> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<w:document ${WORD_NS}><w:body>${BODY}</w:body></w:document>`,
  );
  zip.file("word/_rels/document.xml.rels", RELATIONSHIPS);
  zip.file("word/numbering.xml", NUMBERING);
  zip.file("word/media/image1.png", PNG_BYTES);
  return zip.generateAsync({ type: "blob" });
}

afterEach(() => {
  cleanup();
});

describe("DocxPreview", () => {
  test("shows a placeholder until the package is parsed", async () => {
    const { container } = render(
      <DocxPreview blob={await docxBlob()} filename="brief.docx" />,
    );

    expect(screen.getByRole("status", { name: "Loading preview" })).toBeTruthy();
    await waitFor(() => expect(container.querySelector("h1")).not.toBeNull());
  });

  test("renders headings, runs, lists, tables, and images", async () => {
    const { container } = render(
      <DocxPreview blob={await docxBlob()} filename="brief.docx" />,
    );

    const heading = await screen.findByRole("heading", {
      name: "Quarterly report",
    });
    expect(heading.tagName).toBe("H1");

    expect(container.querySelector("strong")?.textContent).toBe("Revenue ");
    expect(container.querySelector("em")?.textContent).toBe("grew");

    const listItem = container.querySelector("ul li");
    expect(listItem?.textContent).toBe("EMEA up 12%");

    const cells = Array.from(container.querySelectorAll("table td")).map(
      (cell) => cell.textContent,
    );
    expect(cells).toEqual(["Region", "Total"]);

    const image = container.querySelector("img");
    expect(image?.getAttribute("src")?.startsWith("blob:")).toBe(true);
    expect(image?.getAttribute("class")).toContain("max-w-full");
  });

  test("a package it cannot read falls back to a named error state", async () => {
    render(
      <DocxPreview
        blob={new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])])}
        filename="brief.docx"
      />,
    );

    expect(await screen.findByText("Can't preview this file")).toBeTruthy();
    expect(screen.getByText("brief.docx")).toBeTruthy();
  });

  test("a document with no readable content says so", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<w:document ${WORD_NS}><w:body/></w:document>`,
    );

    render(
      <DocxPreview
        blob={await zip.generateAsync({ type: "blob" })}
        filename="empty.docx"
      />,
    );

    expect(
      await screen.findByText("This document has no readable content."),
    ).toBeTruthy();
  });

  test("image object URLs are revoked on unmount", async () => {
    const revoke = spyOn(URL, "revokeObjectURL");
    revoke.mockClear();

    const { container, unmount } = render(
      <DocxPreview blob={await docxBlob()} filename="brief.docx" />,
    );

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const source = container.querySelector("img")!.getAttribute("src")!;

    unmount();

    expect(revoke).toHaveBeenCalledWith(source);
    revoke.mockRestore();
  });
});
