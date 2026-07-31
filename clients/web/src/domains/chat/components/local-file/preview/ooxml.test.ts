import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  type DocxBlock,
  ParseError,
  parseDocx,
  parsePptx,
} from "@/domains/chat/components/local-file/preview/ooxml";

const WORD_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';

const SLIDE_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** Eight bytes is enough: nothing under test decodes the image. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function documentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${WORD_NS}><w:body>${body}</w:body></w:document>`;
}

function relationshipsXml(
  entries: Array<{ id: string; target: string }>,
): string {
  const relationships = entries
    .map(
      (entry) =>
        `<Relationship Id="${entry.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${entry.target}"/>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`;
}

function slideXml(shapes: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${SLIDE_NS}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;
}

async function zipBlob(
  files: Record<string, string | Uint8Array>,
): Promise<Blob> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  return zip.generateAsync({ type: "blob" });
}

function docxBlob(
  body: string,
  extra: Record<string, string | Uint8Array> = {},
): Promise<Blob> {
  return zipBlob({ "word/document.xml": documentXml(body), ...extra });
}

/** A run with the given text and no run properties. */
function run(text: string): string {
  return `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
}

function paragraph(text: string): string {
  return `<w:p>${run(text)}</w:p>`;
}

function textOf(block: DocxBlock): string {
  if (block.type === "table" || block.type === "image") {
    return "";
  }
  return block.runs.map((textRun) => textRun.text).join("");
}

describe("parseDocx: block structure", () => {
  test("paragraph styles map to headings and body text", async () => {
    const blob = await docxBlob(
      `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${run("Quarterly report")}</w:p>` +
        `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>${run("Revenue")}</w:p>` +
        `<w:p><w:pPr><w:pStyle w:val="Heading 3"/></w:pPr>${run("By region")}</w:p>` +
        paragraph("Revenue grew."),
    );

    const { blocks } = await parseDocx(blob);

    expect(blocks.map((block) => [block.type, textOf(block)])).toEqual([
      ["heading", "Quarterly report"],
      ["heading", "Revenue"],
      ["heading", "By region"],
      ["paragraph", "Revenue grew."],
    ]);
    expect(blocks[0]).toMatchObject({ type: "heading", level: 1 });
    expect(blocks[1]).toMatchObject({ type: "heading", level: 2 });
    expect(blocks[2]).toMatchObject({ type: "heading", level: 3 });
  });

  test("empty paragraphs produce no block", async () => {
    const blob = await docxBlob(`<w:p/><w:p><w:r><w:t></w:t></w:r></w:p>`);

    expect((await parseDocx(blob)).blocks).toEqual([]);
  });

  test("content inside a structured document tag is read", async () => {
    const blob = await docxBlob(
      `<w:sdt><w:sdtContent>${paragraph("Boilerplate")}</w:sdtContent></w:sdt>`,
    );

    expect((await parseDocx(blob)).blocks).toEqual([
      {
        type: "paragraph",
        runs: [{ text: "Boilerplate", bold: false, italic: false }],
      },
    ]);
  });
});

describe("parseDocx: runs", () => {
  test("bold and italic toggles carry through", async () => {
    const blob = await docxBlob(
      `<w:p>` +
        `<w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r>` +
        `<w:r><w:rPr><w:i/></w:rPr><w:t>italic</w:t></w:r>` +
        `<w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>both</w:t></w:r>` +
        `<w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>plain</w:t></w:r>` +
        `</w:p>`,
    );

    const [block] = (await parseDocx(blob)).blocks;

    expect(block).toEqual({
      type: "paragraph",
      runs: [
        { text: "bold", bold: true, italic: false },
        { text: "italic", bold: false, italic: true },
        { text: "both", bold: true, italic: true },
        { text: "plain", bold: false, italic: false },
      ],
    });
  });

  test("xml:space preserve keeps surrounding whitespace, its absence drops it", async () => {
    const blob = await docxBlob(
      `<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r>` +
        `<w:r><w:t>  world  </w:t></w:r></w:p>`,
    );

    expect(textOf((await parseDocx(blob)).blocks[0]!)).toBe("Hello world");
  });

  test("tabs and breaks become their text equivalents", async () => {
    const blob = await docxBlob(
      `<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>`,
    );

    expect(textOf((await parseDocx(blob)).blocks[0]!)).toBe("a\tb\nc");
  });

  test("runs inside a hyperlink are part of the paragraph", async () => {
    const blob = await docxBlob(
      `<w:p><w:hyperlink r:id="rId9">${run("the docs")}</w:hyperlink></w:p>`,
    );

    expect(textOf((await parseDocx(blob)).blocks[0]!)).toBe("the docs");
  });

  test("deleted text is left out", async () => {
    const blob = await docxBlob(
      `<w:p><w:del><w:r><w:delText>gone</w:delText></w:r></w:del>${run("kept")}</w:p>`,
    );

    expect(textOf((await parseDocx(blob)).blocks[0]!)).toBe("kept");
  });
});

describe("parseDocx: lists", () => {
  const numberingXml =
    `<?xml version="1.0"?><w:numbering ${WORD_NS}>` +
    `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
    `<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>` +
    `</w:numbering>`;

  function listParagraph(text: string, numId: string, level: string): string {
    return `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${run(text)}</w:p>`;
  }

  test("numbering formats decide bullet versus ordered, and ilvl the depth", async () => {
    const blob = await docxBlob(
      listParagraph("first bullet", "1", "0") +
        listParagraph("nested bullet", "1", "1") +
        listParagraph("first step", "2", "0"),
      { "word/numbering.xml": numberingXml },
    );

    expect((await parseDocx(blob)).blocks).toEqual([
      {
        type: "listItem",
        ordered: false,
        level: 0,
        runs: [{ text: "first bullet", bold: false, italic: false }],
      },
      {
        type: "listItem",
        ordered: false,
        level: 1,
        runs: [{ text: "nested bullet", bold: false, italic: false }],
      },
      {
        type: "listItem",
        ordered: true,
        level: 0,
        runs: [{ text: "first step", bold: false, italic: false }],
      },
    ]);
  });

  test("without a numbering part a list item is still a bulleted list item", async () => {
    const blob = await docxBlob(listParagraph("orphan", "3", "0"));

    expect((await parseDocx(blob)).blocks[0]).toMatchObject({
      type: "listItem",
      ordered: false,
      level: 0,
    });
  });

  test("numId 0 removes the paragraph from its list", async () => {
    const blob = await docxBlob(listParagraph("not a list", "0", "0"));

    expect((await parseDocx(blob)).blocks[0]!.type).toBe("paragraph");
  });
});

describe("parseDocx: tables", () => {
  test("rows and cells map to nested runs", async () => {
    const blob = await docxBlob(
      `<w:tbl>` +
        `<w:tr><w:tc>${paragraph("Region")}</w:tc><w:tc>${paragraph("Total")}</w:tc></w:tr>` +
        `<w:tr><w:tc>${paragraph("EMEA")}</w:tc><w:tc>${paragraph("12")}</w:tc></w:tr>` +
        `</w:tbl>`,
    );

    const [block] = (await parseDocx(blob)).blocks;

    expect(block?.type).toBe("table");
    if (block?.type !== "table") {
      throw new Error("expected a table block");
    }
    expect(
      block.rows.map((row) =>
        row.map((cell) => cell.map((cellRun) => cellRun.text).join("")),
      ),
    ).toEqual([
      ["Region", "Total"],
      ["EMEA", "12"],
    ]);
  });
});

describe("parseDocx: images", () => {
  const drawing = (embedId: string): string =>
    `<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><a:blip r:embed="${embedId}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

  test("a drawing resolves through the document relationships", async () => {
    const blob = await docxBlob(drawing("rId4"), {
      "word/_rels/document.xml.rels": relationshipsXml([
        { id: "rId4", target: "media/image1.png" },
      ]),
      "word/media/image1.png": PNG_BYTES,
    });

    const { blocks, media } = await parseDocx(blob);

    expect(blocks).toEqual([
      { type: "image", mediaPath: "word/media/image1.png" },
    ]);
    const image = media.get("word/media/image1.png");
    expect(image?.type).toBe("image/png");
    expect(image?.size).toBe(PNG_BYTES.byteLength);
  });

  test("an image inside a text paragraph follows the text block", async () => {
    const blob = await docxBlob(
      `<w:p>${run("See below.")}<w:r><w:drawing><a:blip r:embed="rId4"/></w:drawing></w:r></w:p>`,
      {
        "word/_rels/document.xml.rels": relationshipsXml([
          { id: "rId4", target: "media/image1.png" },
        ]),
        "word/media/image1.png": PNG_BYTES,
      },
    );

    expect((await parseDocx(blob)).blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "image",
    ]);
  });

  test("an unresolvable relationship yields no image block", async () => {
    const blob = await docxBlob(drawing("rIdMissing"), {
      "word/_rels/document.xml.rels": relationshipsXml([
        { id: "rId4", target: "media/image1.png" },
      ]),
      "word/media/image1.png": PNG_BYTES,
    });

    const { blocks, media } = await parseDocx(blob);

    expect(blocks).toEqual([]);
    expect(media.size).toBe(0);
  });

  test("media the browser cannot render is skipped", async () => {
    const blob = await docxBlob(drawing("rId4"), {
      "word/_rels/document.xml.rels": relationshipsXml([
        { id: "rId4", target: "media/diagram.emf" },
      ]),
      "word/media/diagram.emf": PNG_BYTES,
    });

    const { blocks, media } = await parseDocx(blob);

    expect(blocks).toEqual([]);
    expect(media.size).toBe(0);
  });

  test("images past the cap are dropped, and the text still parses", async () => {
    const total = 60;
    const entries: Array<{ id: string; target: string }> = [];
    const extra: Record<string, string | Uint8Array> = {};
    let body = paragraph("Screenshots follow.");
    for (let i = 0; i < total; i += 1) {
      entries.push({ id: `rId${i}`, target: `media/image${i}.png` });
      extra[`word/media/image${i}.png`] = PNG_BYTES;
      body += drawing(`rId${i}`);
    }
    const blob = await docxBlob(body, {
      ...extra,
      "word/_rels/document.xml.rels": relationshipsXml(entries),
    });

    const { blocks, media } = await parseDocx(blob);

    expect(media.size).toBe(50);
    expect(blocks.filter((block) => block.type === "image").length).toBe(50);
    expect(blocks[0]).toMatchObject({ type: "paragraph" });
  });
});

describe("parseDocx: malformed and oversized input", () => {
  test("bytes that are not a zip", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]);

    await expect(parseDocx(blob)).rejects.toBeInstanceOf(ParseError);
  });

  test("a zip with no document part", async () => {
    const blob = await zipBlob({ "ppt/slides/slide1.xml": slideXml("") });

    await expect(parseDocx(blob)).rejects.toBeInstanceOf(ParseError);
  });

  test("a document part that is not well-formed XML", async () => {
    const blob = await zipBlob({
      "word/document.xml": "<w:document><w:body><w:p></w:document>",
    });

    await expect(parseDocx(blob)).rejects.toBeInstanceOf(ParseError);
  });

  test("a document part with no body", async () => {
    const blob = await zipBlob({
      "word/document.xml": `<w:document ${WORD_NS}/>`,
    });

    await expect(parseDocx(blob)).rejects.toBeInstanceOf(ParseError);
  });

  test("a malformed numbering part does not fail the document", async () => {
    const blob = await docxBlob(paragraph("Still readable."), {
      "word/numbering.xml": "<w:numbering>",
    });

    expect((await parseDocx(blob)).blocks).toHaveLength(1);
  });

  test("text past the extraction cap", async () => {
    const blob = await docxBlob(paragraph("x".repeat(2_000_001)));

    await expect(parseDocx(blob)).rejects.toBeInstanceOf(ParseError);
  });

  test("a package with absurdly many parts", async () => {
    const files: Record<string, string | Uint8Array> = {
      "word/document.xml": documentXml(paragraph("hi")),
    };
    for (let i = 0; i < 4001; i += 1) {
      files[`word/embeddings/part${i}.bin`] = "x";
    }
    const blob = await zipBlob(files);

    await expect(parseDocx(blob)).rejects.toBeInstanceOf(ParseError);
  });
});

describe("parsePptx", () => {
  function textShape(paragraphs: string, placeholder = ""): string {
    return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="shape"/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:txBody>${paragraphs}</p:txBody></p:sp>`;
  }

  function drawingParagraph(text: string, level?: string): string {
    const properties = level === undefined ? "" : `<a:pPr lvl="${level}"/>`;
    return `<a:p>${properties}<a:r><a:t>${text}</a:t></a:r></a:p>`;
  }

  test("slides are ordered numerically, not lexically", async () => {
    const blob = await zipBlob({
      "ppt/slides/slide1.xml": slideXml(
        textShape(drawingParagraph("one"), '<p:ph type="title"/>'),
      ),
      "ppt/slides/slide2.xml": slideXml(
        textShape(drawingParagraph("two"), '<p:ph type="title"/>'),
      ),
      "ppt/slides/slide10.xml": slideXml(
        textShape(drawingParagraph("ten"), '<p:ph type="title"/>'),
      ),
    });

    const { slides } = await parsePptx(blob);

    expect(slides.map((slide) => [slide.index, slide.title])).toEqual([
      [1, "one"],
      [2, "two"],
      [3, "ten"],
    ]);
  });

  test("a title placeholder becomes the title, everything else the body", async () => {
    const blob = await zipBlob({
      "ppt/slides/slide1.xml": slideXml(
        textShape(drawingParagraph("Roadmap"), '<p:ph type="ctrTitle"/>') +
          textShape(
            drawingParagraph("Ship it") +
              drawingParagraph("Then measure", "1") +
              drawingParagraph("Deeply", "2"),
          ),
      ),
    });

    const [slide] = (await parsePptx(blob)).slides;

    expect(slide?.title).toBe("Roadmap");
    expect(
      slide?.paragraphs.map((paragraph) => [
        paragraph.level,
        paragraph.runs.map((textRun) => textRun.text).join(""),
      ]),
    ).toEqual([
      [0, "Ship it"],
      [1, "Then measure"],
      [2, "Deeply"],
    ]);
  });

  test("a slide with no title placeholder has a null title", async () => {
    const blob = await zipBlob({
      "ppt/slides/slide1.xml": slideXml(textShape(drawingParagraph("Body"))),
    });

    const [slide] = (await parsePptx(blob)).slides;

    expect(slide?.title).toBeNull();
    expect(slide?.paragraphs).toHaveLength(1);
  });

  test("run properties carry bold and italic", async () => {
    const blob = await zipBlob({
      "ppt/slides/slide1.xml": slideXml(
        textShape(
          `<a:p><a:r><a:rPr b="1" i="1"/><a:t>emphasis</a:t></a:r><a:r><a:rPr b="0"/><a:t> plain</a:t></a:r></a:p>`,
        ),
      ),
    });

    const [slide] = (await parsePptx(blob)).slides;

    expect(slide?.paragraphs[0]?.runs).toEqual([
      { text: "emphasis", bold: true, italic: true },
      { text: " plain", bold: false, italic: false },
    ]);
  });

  test("pictures resolve through the slide relationships", async () => {
    const blob = await zipBlob({
      "ppt/slides/slide1.xml": slideXml(
        `<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>`,
      ),
      "ppt/slides/_rels/slide1.xml.rels": relationshipsXml([
        { id: "rId2", target: "../media/image1.png" },
      ]),
      "ppt/media/image1.png": PNG_BYTES,
    });

    const { slides, media } = await parsePptx(blob);

    expect(slides[0]?.imageMediaPaths).toEqual(["ppt/media/image1.png"]);
    expect(media.get("ppt/media/image1.png")?.type).toBe("image/png");
  });

  test("a package with no slides", async () => {
    const blob = await zipBlob({ "docProps/app.xml": "<Properties/>" });

    await expect(parsePptx(blob)).rejects.toBeInstanceOf(ParseError);
  });

  test("bytes that are not a zip", async () => {
    await expect(
      parsePptx(new Blob([new Uint8Array([9, 9, 9, 9])])),
    ).rejects.toBeInstanceOf(ParseError);
  });

  test("a slide part that is not well-formed XML", async () => {
    const blob = await zipBlob({ "ppt/slides/slide1.xml": "<p:sld>" });

    await expect(parsePptx(blob)).rejects.toBeInstanceOf(ParseError);
  });
});

describe("real-world producer quirks", () => {
  test("a single-quoted XML declaration parses (python-docx, lxml)", async () => {
    const declared = documentXml(paragraph("hello")).replace(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>",
    );
    const blob = await zipBlob({ "word/document.xml": declared });

    const { blocks } = await parseDocx(blob);

    expect(blocks).toHaveLength(1);
    expect(textOf(blocks[0]!)).toBe("hello");
  });

  test("style-based lists without inline numPr become list items", async () => {
    const blob = await docxBlob(
      [
        `<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr>${run("first")}</w:p>`,
        `<w:p><w:pPr><w:pStyle w:val="ListBullet2"/></w:pPr>${run("nested")}</w:p>`,
        `<w:p><w:pPr><w:pStyle w:val="ListNumber"/></w:pPr>${run("step")}</w:p>`,
      ].join(""),
    );

    const { blocks } = await parseDocx(blob);

    expect(
      blocks.map((b) =>
        b.type === "listItem"
          ? { o: b.ordered, l: b.level, t: textOf(b) }
          : b.type,
      ),
    ).toEqual([
      { o: false, l: 0, t: "first" },
      { o: false, l: 1, t: "nested" },
      { o: true, l: 0, t: "step" },
    ]);
  });
});
