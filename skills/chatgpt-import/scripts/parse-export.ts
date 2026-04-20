#!/usr/bin/env bun

/**
 * Parse a ChatGPT export ZIP and output the standard conversation import
 * JSON format expected by `assistant conversations import`.
 *
 * Usage:
 *   bun run scripts/parse-export.ts --file /path/to/chatgpt-export.zip
 */

import { existsSync, readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

// -- ChatGPT export format types --

interface ChatGPTContent {
  content_type: string;
  parts?: (string | null | Record<string, unknown>)[];
}

interface ChatGPTNode {
  message: {
    author: { role: string };
    content: ChatGPTContent;
    create_time?: number | null;
  } | null;
  parent: string | null;
  children: string[];
}

interface ChatGPTConversation {
  id?: string;
  title: string;
  create_time: number;
  update_time: number;
  current_node: string;
  mapping: Record<string, ChatGPTNode>;
}

// -- Output types (matches `assistant conversations import` schema) --

interface OutputMessage {
  role: string;
  content: Array<{ type: string; text: string }>;
  createdAt: number;
}

interface OutputConversation {
  sourceKey: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: OutputMessage[];
}

// -- Argument parsing --

function parseCliArgs(): { filePath: string } {
  const args = process.argv.slice(2);
  let filePath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && i + 1 < args.length) {
      filePath = args[i + 1];
      i++;
    }
  }

  if (!filePath) {
    process.stderr.write(
      "Usage: bun run scripts/parse-export.ts --file <path-to-zip>\n",
    );
    process.exit(1);
  }

  return { filePath };
}

// -- ChatGPT conversation parser --

function parseChatGPTExport(zipPath: string): OutputConversation[] {
  const jsonContent = extractConversationsJsonFromZip(zipPath);

  const raw = JSON.parse(jsonContent);
  if (!Array.isArray(raw)) {
    throw new Error("Expected conversations.json to contain a JSON array");
  }

  const results: OutputConversation[] = [];
  for (const conv of raw as ChatGPTConversation[]) {
    const parsed = parseConversation(conv);
    if (parsed) {
      results.push(parsed);
    }
  }
  return results;
}

function parseConversation(
  conv: ChatGPTConversation,
): OutputConversation | null {
  const { mapping, current_node } = conv;
  if (!mapping || !current_node || !mapping[current_node]) return null;

  // Walk from current_node to root via parent pointers, then reverse
  const nodeIds: string[] = [];
  let nodeId: string | null = current_node;
  while (nodeId) {
    nodeIds.push(nodeId);
    nodeId = mapping[nodeId]?.parent ?? null;
  }
  nodeIds.reverse();

  const messages: OutputMessage[] = [];
  for (const id of nodeIds) {
    const node = mapping[id];
    if (!node?.message) continue;

    const { author, content, create_time } = node.message;
    const role = author?.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = extractText(content);
    if (!text) continue;

    messages.push({
      role,
      content: [{ type: "text", text }],
      createdAt: create_time
        ? Math.round(create_time * 1000)
        : Math.round(conv.create_time * 1000),
    });
  }

  if (messages.length === 0) return null;

  const sourceId = conv.id ?? `${conv.title}-${conv.create_time}`;

  return {
    sourceKey: `chatgpt:${sourceId}`,
    title: conv.title || "Untitled",
    createdAt: Math.round(conv.create_time * 1000),
    updatedAt: Math.round(conv.update_time * 1000),
    messages,
  };
}

function extractText(content: ChatGPTContent): string {
  if (!content?.parts) return "";
  return content.parts
    .filter((p): p is string => typeof p === "string")
    .join("");
}

// -- ZIP extraction --

function extractConversationsJsonFromZip(zipPath: string): string {
  const buffer = readFileSync(zipPath);

  // Find end of central directory record (EOCD signature: 0x06054b50)
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (
      buffer[i] === 0x50 &&
      buffer[i + 1] === 0x4b &&
      buffer[i + 2] === 0x05 &&
      buffer[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error(
      "Invalid ZIP file: could not find end of central directory",
    );
  }

  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  const centralDirEntries = buffer.readUInt16LE(eocdOffset + 10);

  // Walk central directory to find conversations.json
  let offset = centralDirOffset;
  for (let i = 0; i < centralDirEntries; i++) {
    if (
      buffer[offset] !== 0x50 ||
      buffer[offset + 1] !== 0x4b ||
      buffer[offset + 2] !== 0x01 ||
      buffer[offset + 3] !== 0x02
    ) {
      throw new Error("Invalid ZIP central directory entry");
    }

    const cdCompressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer
      .subarray(offset + 46, offset + 46 + fileNameLength)
      .toString("utf-8");

    if (
      fileName === "conversations.json" ||
      fileName.endsWith("/conversations.json")
    ) {
      return extractLocalFile(buffer, localHeaderOffset, cdCompressedSize);
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error("conversations.json not found in ZIP file");
}

function extractLocalFile(
  buffer: Buffer,
  offset: number,
  cdCompressedSize: number,
): string {
  if (
    buffer[offset] !== 0x50 ||
    buffer[offset + 1] !== 0x4b ||
    buffer[offset + 2] !== 0x03 ||
    buffer[offset + 3] !== 0x04
  ) {
    throw new Error("Invalid ZIP local file header");
  }

  const compressionMethod = buffer.readUInt16LE(offset + 8);
  const localCompressedSize = buffer.readUInt32LE(offset + 18);
  const compressedSize =
    cdCompressedSize > 0 ? cdCompressedSize : localCompressedSize;
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);

  const dataOffset = offset + 30 + fileNameLength + extraLength;
  const fileData = buffer.subarray(dataOffset, dataOffset + compressedSize);

  if (compressionMethod === 0) {
    return fileData.toString("utf-8");
  } else if (compressionMethod === 8) {
    return inflateRawSync(fileData).toString("utf-8");
  } else {
    throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
  }
}

// -- Main --

function main() {
  const { filePath } = parseCliArgs();

  if (!filePath.endsWith(".zip")) {
    process.stderr.write(
      "Error: Only ZIP files are accepted. Please provide the ChatGPT export ZIP file.\n",
    );
    process.exit(1);
  }

  if (!existsSync(filePath)) {
    process.stderr.write(`Error: File not found: ${filePath}\n`);
    process.exit(1);
  }

  let conversations: OutputConversation[];
  try {
    conversations = parseChatGPTExport(filePath);
  } catch (err) {
    process.stderr.write(
      `Error parsing export file: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({ conversations }) + "\n");
}

main();
