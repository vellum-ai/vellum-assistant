/**
 * Client-side extraction of readable content from OOXML packages (`.docx`,
 * `.pptx`) so the chat drawer can preview them without a server round trip.
 *
 * An OOXML file is a zip of XML parts. This module unzips it, walks the parts
 * that carry visible content, and returns plain data: text runs, block
 * structure, and the embedded images as blobs. It renders nothing and touches
 * no React — the preview components own presentation, and the tests exercise
 * the mapping directly.
 *
 * Fidelity is deliberately partial. The goal is a readable document, not a
 * faithful reproduction: styling beyond bold/italic, section layout, floating
 * shapes, charts, and vector-only media (`emf`/`wmf`) are dropped.
 */

import JSZip from "jszip";

/** Text with the only two run properties the previews render. */
export interface TextRun {
  text: string;
  bold: boolean;
  italic: boolean;
}

/**
 * A block of Word content. `table` rows hold cells, and each cell holds the
 * runs of every paragraph in it, flattened.
 */
export type DocxBlock =
  | { type: "heading"; level: number; runs: TextRun[] }
  | { type: "paragraph"; runs: TextRun[] }
  | { type: "listItem"; ordered: boolean; level: number; runs: TextRun[] }
  | { type: "table"; rows: TextRun[][][] }
  | { type: "image"; mediaPath: string };

export interface DocxDocument {
  blocks: DocxBlock[];
  /** Zip entry path (e.g. `word/media/image1.png`) to its decoded bytes. */
  media: Map<string, Blob>;
}

export interface PptxParagraph {
  /** Outline depth, 0 for a top-level line. */
  level: number;
  runs: TextRun[];
}

export interface PptxSlide {
  /** 1-based position in the deck. */
  index: number;
  title: string | null;
  paragraphs: PptxParagraph[];
  imageMediaPaths: string[];
}

export interface PptxDeck {
  slides: PptxSlide[];
  /** Zip entry path (e.g. `ppt/media/image1.png`) to its decoded bytes. */
  media: Map<string, Blob>;
}

/** Thrown for any input this module refuses to read. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

/** Parts in a real Office package; anything larger is not a document. */
const MAX_ZIP_ENTRIES = 4000;

/** Extracted characters, past which the preview would not be readable anyway. */
const MAX_TEXT_CHARS = 2_000_000;

/** Embedded images decoded per file. Later images are dropped, not fatal. */
const MAX_IMAGES = 50;

const MAX_SLIDES = 200;

/** Deepest list/outline indent the previews render. */
const MAX_LEVEL = 8;

/** Toggle-property values that mean "off" rather than "present". */
const OFF_VALUES = new Set(["0", "false", "off"]);

/** Media the browser can render in an `<img>`; other parts are skipped. */
const MEDIA_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

const SLIDE_ENTRY_PATTERN = /^ppt\/slides\/slide(\d+)\.xml$/;

interface TextBudget {
  remaining: number;
}

/**
 * Namespace prefixes are not fixed by the spec, and neither happy-dom nor every
 * XML parser exposes `localName`, so every lookup compares the part after the
 * prefix.
 */
function localNameOf(node: Element): string {
  const qualified = node.tagName;
  const colon = qualified.indexOf(":");
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

function childElements(element: Element): Element[] {
  return Array.from(element.children);
}

function childrenNamed(element: Element, name: string): Element[] {
  return childElements(element).filter((child) => localNameOf(child) === name);
}

function firstChildNamed(element: Element, name: string): Element | null {
  return childrenNamed(element, name)[0] ?? null;
}

function descendantsNamed(root: Element, name: string): Element[] {
  const found: Element[] = [];
  const visit = (element: Element): void => {
    for (const child of childElements(element)) {
      if (localNameOf(child) === name) {
        found.push(child);
      }
      visit(child);
    }
  };
  visit(root);
  return found;
}

/** Attribute lookup by local name, so `w:val` and `val` both match `val`. */
function attrNamed(element: Element, name: string): string | null {
  const attributes = element.attributes;
  for (let i = 0; i < attributes.length; i += 1) {
    const attribute = attributes[i];
    if (!attribute) {
      continue;
    }
    const qualified = attribute.name;
    const colon = qualified.indexOf(":");
    const local = colon === -1 ? qualified : qualified.slice(colon + 1);
    if (local === name) {
      return attribute.value;
    }
  }
  return null;
}

/** WordprocessingML toggle: present means on unless `w:val` says otherwise. */
function isWordToggleOn(properties: Element | null, name: string): boolean {
  if (properties === null) {
    return false;
  }
  const toggle = firstChildNamed(properties, name);
  if (toggle === null) {
    return false;
  }
  const value = attrNamed(toggle, "val");
  return value === null || !OFF_VALUES.has(value.toLowerCase());
}

/** DrawingML toggle: an attribute on the run properties element. */
function isDrawingToggleOn(properties: Element | null, name: string): boolean {
  if (properties === null) {
    return false;
  }
  const value = attrNamed(properties, name);
  return value === "1" || value === "true";
}

function parseLevel(raw: string | null): number {
  if (raw === null) {
    return 0;
  }
  const level = Number.parseInt(raw, 10);
  if (!Number.isFinite(level) || level < 0) {
    return 0;
  }
  return Math.min(level, MAX_LEVEL);
}

function spend(budget: TextBudget, text: string): void {
  budget.remaining -= text.length;
  if (budget.remaining < 0) {
    throw new ParseError("This file holds too much text to preview.");
  }
}

function parseXml(text: string, entryPath: string): Element {
  // The declaration carries nothing the parser needs, and real-world
  // producers vary its shape (python-docx writes single-quoted attributes,
  // which some DOM implementations refuse). Strip it, and any BOM, first.
  const withoutDeclaration = text.replace(/^﻿?\s*<\?xml[^>]*\?>\s*/, "");
  const document = new DOMParser().parseFromString(
    withoutDeclaration,
    "application/xml",
  );
  const root = document.documentElement;
  if (
    root === null ||
    document.getElementsByTagName("parsererror").length > 0 ||
    localNameOf(root) === "parsererror"
  ) {
    throw new ParseError(`The ${entryPath} part is not valid XML.`);
  }
  return root;
}

async function loadPackage(blob: Blob): Promise<JSZip> {
  let zip: JSZip;
  try {
    // ArrayBuffer rather than the Blob itself: JSZip reads Blobs through
    // FileReader, which not every runtime provides.
    zip = await JSZip.loadAsync(await blob.arrayBuffer());
  } catch {
    throw new ParseError("This file is not a readable Office package.");
  }
  if (Object.keys(zip.files).length > MAX_ZIP_ENTRIES) {
    throw new ParseError("This Office package has too many parts to preview.");
  }
  return zip;
}

async function readText(zip: JSZip, path: string): Promise<string | null> {
  const entry = zip.file(path);
  if (entry === null) {
    return null;
  }
  return entry.async("string");
}

/** Resolve a relationship target against the directory holding the part. */
function resolvePackagePath(baseDir: string, target: string): string {
  if (target.startsWith("/")) {
    return target.slice(1);
  }
  const segments: string[] = [];
  for (const segment of `${baseDir}/${target}`.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** Relationship id to package path, skipping targets outside the package. */
async function readRelationships(
  zip: JSZip,
  relsPath: string,
  baseDir: string,
): Promise<Map<string, string>> {
  const relationships = new Map<string, string>();
  const xml = await readText(zip, relsPath);
  if (xml === null) {
    return relationships;
  }
  const root = parseXml(xml, relsPath);
  for (const relationship of childrenNamed(root, "Relationship")) {
    const id = attrNamed(relationship, "Id");
    const target = attrNamed(relationship, "Target");
    if (id === null || target === null) {
      continue;
    }
    if (attrNamed(relationship, "TargetMode") === "External") {
      continue;
    }
    relationships.set(id, resolvePackagePath(baseDir, target));
  }
  return relationships;
}

function mediaMimeType(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) {
    return null;
  }
  return MEDIA_MIME_TYPES[path.slice(dot + 1).toLowerCase()] ?? null;
}

async function readMedia(
  zip: JSZip,
  paths: readonly string[],
): Promise<Map<string, Blob>> {
  const media = new Map<string, Blob>();
  for (const path of paths) {
    if (media.has(path)) {
      continue;
    }
    const type = mediaMimeType(path);
    const entry = zip.file(path);
    if (type === null || entry === null) {
      continue;
    }
    const bytes = await entry.async("uint8array");
    media.set(path, new Blob([new Uint8Array(bytes)], { type }));
  }
  return media;
}

/**
 * Record a referenced image and return its package path. Returns null once the
 * image cap is reached so a screenshot-heavy file still previews its text.
 */
function resolveEmbeddedImage(
  blip: Element,
  relationships: Map<string, string>,
  mediaPaths: string[],
): string | null {
  const id = attrNamed(blip, "embed");
  if (id === null) {
    return null;
  }
  const path = relationships.get(id);
  if (path === undefined || mediaMimeType(path) === null) {
    return null;
  }
  if (!mediaPaths.includes(path)) {
    if (mediaPaths.length >= MAX_IMAGES) {
      return null;
    }
    mediaPaths.push(path);
  }
  return path;
}

interface DocxContext {
  relationships: Map<string, string>;
  /** `${numId}:${ilvl}` to whether that level is numbered rather than bulleted. */
  numbering: Map<string, boolean>;
  budget: TextBudget;
  mediaPaths: string[];
  blocks: DocxBlock[];
}

/** Elements whose text belongs to something other than the paragraph body. */
const DOCX_RUN_SKIP = new Set(["pPr", "rPr", "drawing", "pict", "del"]);

function readWordRun(run: Element, budget: TextBudget): string {
  let text = "";
  for (const child of childElements(run)) {
    const name = localNameOf(child);
    if (name === "t") {
      const raw = child.textContent ?? "";
      // Without `xml:space="preserve"` the spec drops surrounding whitespace.
      text += attrNamed(child, "space") === "preserve" ? raw : raw.trim();
    } else if (name === "tab") {
      text += "\t";
    } else if (name === "br" || name === "cr") {
      text += "\n";
    } else if (name === "noBreakHyphen") {
      text += "-";
    }
  }
  spend(budget, text);
  return text;
}

function collectWordRuns(scope: Element, budget: TextBudget): TextRun[] {
  const runs: TextRun[] = [];
  const visit = (element: Element): void => {
    for (const child of childElements(element)) {
      const name = localNameOf(child);
      if (DOCX_RUN_SKIP.has(name)) {
        continue;
      }
      if (name === "r") {
        const text = readWordRun(child, budget);
        if (text.length > 0) {
          const properties = firstChildNamed(child, "rPr");
          runs.push({
            text,
            bold: isWordToggleOn(properties, "b"),
            italic: isWordToggleOn(properties, "i"),
          });
        }
        continue;
      }
      visit(child);
    }
  };
  visit(scope);
  return runs;
}

function headingLevelOf(properties: Element | null): number | null {
  if (properties === null) {
    return null;
  }
  const style = firstChildNamed(properties, "pStyle");
  if (style === null) {
    return null;
  }
  const value = attrNamed(style, "val");
  if (value === null) {
    return null;
  }
  const normalized = value.replace(/[\s_-]/g, "").toLowerCase();
  if (normalized === "title") {
    return 1;
  }
  const match = /^heading([1-6])$/.exec(normalized);
  return match === null ? null : Number(match[1]);
}

/**
 * List membership carried by the paragraph style alone. Word writes `w:numPr`
 * inline, but python-docx and some templates rely on the built-in
 * `ListBullet`/`ListNumber` styles (optionally suffixed 2-3 for depth) whose
 * numbering lives in styles.xml.
 */
function styleListPropertiesOf(
  properties: Element,
): { ordered: boolean; level: number } | null {
  const style = firstChildNamed(properties, "pStyle");
  const value = style === null ? null : attrNamed(style, "val");
  if (value === null) {
    return null;
  }
  const match = /^list(bullet|number)([2-9])?$/.exec(
    value.replace(/[\s_-]/g, "").toLowerCase(),
  );
  if (match === null) {
    return null;
  }
  return {
    ordered: match[1] === "number",
    level: match[2] === undefined ? 0 : Number(match[2]) - 1,
  };
}

function listPropertiesOf(
  properties: Element | null,
  numbering: Map<string, boolean>,
): { ordered: boolean; level: number } | null {
  if (properties === null) {
    return null;
  }
  const numPr = firstChildNamed(properties, "numPr");
  if (numPr === null) {
    return styleListPropertiesOf(properties);
  }
  const levelElement = firstChildNamed(numPr, "ilvl");
  const idElement = firstChildNamed(numPr, "numId");
  const numId = idElement === null ? null : attrNamed(idElement, "val");
  // `w:numId` 0 explicitly removes the paragraph from its list.
  if (numId === "0") {
    return null;
  }
  const level = parseLevel(
    levelElement === null ? null : attrNamed(levelElement, "val"),
  );
  const ordered =
    numId === null
      ? false
      : (numbering.get(`${numId}:${level}`) ??
        numbering.get(`${numId}:0`) ??
        false);
  return { ordered, level };
}

/** Map each `w:num` id and level to whether it is numbered rather than bulleted. */
async function readNumbering(zip: JSZip): Promise<Map<string, boolean>> {
  const numbering = new Map<string, boolean>();
  const xml = await readText(zip, "word/numbering.xml");
  if (xml === null) {
    return numbering;
  }
  let root: Element;
  try {
    root = parseXml(xml, "word/numbering.xml");
  } catch {
    return numbering;
  }
  const abstractFormats = new Map<string, Map<string, boolean>>();
  for (const abstract of childrenNamed(root, "abstractNum")) {
    const abstractId = attrNamed(abstract, "abstractNumId");
    if (abstractId === null) {
      continue;
    }
    const levels = new Map<string, boolean>();
    for (const level of childrenNamed(abstract, "lvl")) {
      const format = firstChildNamed(level, "numFmt");
      const value = format === null ? null : attrNamed(format, "val");
      levels.set(
        attrNamed(level, "ilvl") ?? "0",
        value !== null && value !== "bullet" && value !== "none",
      );
    }
    abstractFormats.set(abstractId, levels);
  }
  for (const num of childrenNamed(root, "num")) {
    const numId = attrNamed(num, "numId");
    const reference = firstChildNamed(num, "abstractNumId");
    const abstractId = reference === null ? null : attrNamed(reference, "val");
    if (numId === null || abstractId === null) {
      continue;
    }
    const levels = abstractFormats.get(abstractId);
    if (levels === undefined) {
      continue;
    }
    for (const [level, ordered] of levels) {
      numbering.set(`${numId}:${level}`, ordered);
    }
  }
  return numbering;
}

function appendParagraphBlock(paragraph: Element, context: DocxContext): void {
  const properties = firstChildNamed(paragraph, "pPr");
  const runs = collectWordRuns(paragraph, context.budget);

  if (runs.length > 0) {
    const heading = headingLevelOf(properties);
    const list = listPropertiesOf(properties, context.numbering);
    if (heading !== null) {
      context.blocks.push({ type: "heading", level: heading, runs });
    } else if (list !== null) {
      context.blocks.push({
        type: "listItem",
        ordered: list.ordered,
        level: list.level,
        runs,
      });
    } else {
      context.blocks.push({ type: "paragraph", runs });
    }
  }

  // Images sit inside a run but render as their own block, after the text of
  // the paragraph that anchors them.
  for (const blip of descendantsNamed(paragraph, "blip")) {
    const mediaPath = resolveEmbeddedImage(
      blip,
      context.relationships,
      context.mediaPaths,
    );
    if (mediaPath !== null) {
      context.blocks.push({ type: "image", mediaPath });
    }
  }
}

function appendTableBlock(table: Element, context: DocxContext): void {
  const rows: TextRun[][][] = [];
  for (const row of childrenNamed(table, "tr")) {
    const cells: TextRun[][] = [];
    for (const cell of childrenNamed(row, "tc")) {
      cells.push(collectWordRuns(cell, context.budget));
    }
    rows.push(cells);
  }
  if (rows.length > 0) {
    context.blocks.push({ type: "table", rows });
  }
}

function collectDocxBlocks(container: Element, context: DocxContext): void {
  for (const child of childElements(container)) {
    const name = localNameOf(child);
    if (name === "p") {
      appendParagraphBlock(child, context);
    } else if (name === "tbl") {
      appendTableBlock(child, context);
    } else if (name === "sdt") {
      const content = firstChildNamed(child, "sdtContent");
      if (content !== null) {
        collectDocxBlocks(content, context);
      }
    }
  }
}

/**
 * Read the readable content of a `.docx` package.
 *
 * @throws {ParseError} when the blob is not a Word package, its document part
 * is missing or malformed, or it exceeds the extraction caps.
 */
export async function parseDocx(blob: Blob): Promise<DocxDocument> {
  const zip = await loadPackage(blob);
  const xml = await readText(zip, "word/document.xml");
  if (xml === null) {
    throw new ParseError("This file has no Word document part.");
  }
  const root = parseXml(xml, "word/document.xml");
  const body = firstChildNamed(root, "body");
  if (body === null) {
    throw new ParseError("This Word document has no body.");
  }

  const context: DocxContext = {
    relationships: await readRelationships(
      zip,
      "word/_rels/document.xml.rels",
      "word",
    ),
    numbering: await readNumbering(zip),
    budget: { remaining: MAX_TEXT_CHARS },
    mediaPaths: [],
    blocks: [],
  };
  collectDocxBlocks(body, context);

  return {
    blocks: context.blocks,
    media: await readMedia(zip, context.mediaPaths),
  };
}

interface PptxContext {
  relationships: Map<string, string>;
  budget: TextBudget;
  mediaPaths: string[];
}

function readDrawingRuns(paragraph: Element, budget: TextBudget): TextRun[] {
  const runs: TextRun[] = [];
  for (const child of childElements(paragraph)) {
    const name = localNameOf(child);
    if (name !== "r" && name !== "fld") {
      continue;
    }
    const textElement = firstChildNamed(child, "t");
    const text = textElement === null ? "" : (textElement.textContent ?? "");
    if (text.length === 0) {
      continue;
    }
    spend(budget, text);
    const properties = firstChildNamed(child, "rPr");
    runs.push({
      text,
      bold: isDrawingToggleOn(properties, "b"),
      italic: isDrawingToggleOn(properties, "i"),
    });
  }
  return runs;
}

function readTextBody(body: Element, budget: TextBudget): PptxParagraph[] {
  const paragraphs: PptxParagraph[] = [];
  for (const paragraph of childrenNamed(body, "p")) {
    const runs = readDrawingRuns(paragraph, budget);
    if (runs.length === 0) {
      continue;
    }
    const properties = firstChildNamed(paragraph, "pPr");
    paragraphs.push({
      level: parseLevel(
        properties === null ? null : attrNamed(properties, "lvl"),
      ),
      runs,
    });
  }
  return paragraphs;
}

function isTitlePlaceholder(shape: Element): boolean {
  const shapeProperties = firstChildNamed(shape, "nvSpPr");
  if (shapeProperties === null) {
    return false;
  }
  const nonVisual = firstChildNamed(shapeProperties, "nvPr");
  if (nonVisual === null) {
    return false;
  }
  const placeholder = firstChildNamed(nonVisual, "ph");
  if (placeholder === null) {
    return false;
  }
  const type = attrNamed(placeholder, "type");
  return type === "title" || type === "ctrTitle";
}

function readSlide(
  root: Element,
  index: number,
  context: PptxContext,
): PptxSlide {
  let title: string | null = null;
  const paragraphs: PptxParagraph[] = [];

  for (const shape of descendantsNamed(root, "sp")) {
    const body = firstChildNamed(shape, "txBody");
    if (body === null) {
      continue;
    }
    const shapeParagraphs = readTextBody(body, context.budget);
    if (shapeParagraphs.length === 0) {
      continue;
    }
    if (title === null && isTitlePlaceholder(shape)) {
      const text = shapeParagraphs
        .map((paragraph) => paragraph.runs.map((run) => run.text).join(""))
        .join(" ")
        .trim();
      title = text.length > 0 ? text : null;
      continue;
    }
    paragraphs.push(...shapeParagraphs);
  }

  const imageMediaPaths: string[] = [];
  for (const picture of descendantsNamed(root, "pic")) {
    for (const blip of descendantsNamed(picture, "blip")) {
      const mediaPath = resolveEmbeddedImage(
        blip,
        context.relationships,
        context.mediaPaths,
      );
      if (mediaPath !== null) {
        imageMediaPaths.push(mediaPath);
      }
    }
  }

  return { index, title, paragraphs, imageMediaPaths };
}

/** Slide parts in deck order, which is the numeric order of their filenames. */
function slideEntryPaths(zip: JSZip): string[] {
  const entries: Array<{ path: string; position: number }> = [];
  for (const path of Object.keys(zip.files)) {
    const match = SLIDE_ENTRY_PATTERN.exec(path);
    if (match !== null) {
      entries.push({ path, position: Number(match[1]) });
    }
  }
  entries.sort((left, right) => left.position - right.position);
  return entries.slice(0, MAX_SLIDES).map((entry) => entry.path);
}

/**
 * Read the readable content of a `.pptx` package.
 *
 * @throws {ParseError} when the blob is not a PowerPoint package, holds no
 * slides, has a malformed slide part, or exceeds the extraction caps.
 */
export async function parsePptx(blob: Blob): Promise<PptxDeck> {
  const zip = await loadPackage(blob);
  const slidePaths = slideEntryPaths(zip);
  if (slidePaths.length === 0) {
    throw new ParseError("This file has no slides.");
  }

  const budget: TextBudget = { remaining: MAX_TEXT_CHARS };
  const mediaPaths: string[] = [];
  const slides: PptxSlide[] = [];

  for (let position = 0; position < slidePaths.length; position += 1) {
    const path = slidePaths[position]!;
    const xml = await readText(zip, path);
    if (xml === null) {
      continue;
    }
    const relationships = await readRelationships(
      zip,
      path.replace(/^ppt\/slides\/(.+)$/, "ppt/slides/_rels/$1.rels"),
      "ppt/slides",
    );
    slides.push(
      readSlide(parseXml(xml, path), position + 1, {
        relationships,
        budget,
        mediaPaths,
      }),
    );
  }

  return { slides, media: await readMedia(zip, mediaPaths) };
}
