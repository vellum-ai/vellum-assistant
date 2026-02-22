/**
 * ChatGPT conversations.json parser.
 *
 * Reads the ChatGPT "Export data" format (a JSON array of conversation
 * objects with tree-structured message mappings) and transforms them into
 * Vellum's internal conversation/message format.
 */

import { readFileSync } from 'node:fs';

interface ChatGPTAuthor {
  role: string;
}

interface ChatGPTContent {
  content_type: string;
  parts?: (string | null | Record<string, unknown>)[];
}

interface ChatGPTMessage {
  author: ChatGPTAuthor;
  content: ChatGPTContent;
  create_time?: number | null;
}

interface ChatGPTNode {
  message: ChatGPTMessage | null;
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

export interface ImportedMessage {
  role: string;
  content: Array<{ type: string; text: string }>;
  createdAt: number;
}

export interface ImportedConversation {
  sourceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ImportedMessage[];
}

/**
 * Parse a ChatGPT conversations.json file (or ZIP containing it) and
 * return an array of imported conversations.
 */
export async function parseChatGPTExport(filePath: string): Promise<ImportedConversation[]> {
  let jsonContent: string;

  if (filePath.endsWith('.zip')) {
    jsonContent = await extractFromZip(filePath);
  } else {
    jsonContent = readFileSync(filePath, 'utf-8');
  }

  const raw = JSON.parse(jsonContent);
  if (!Array.isArray(raw)) {
    throw new Error('Expected conversations.json to contain a JSON array');
  }

  const results: ImportedConversation[] = [];
  for (const conv of raw as ChatGPTConversation[]) {
    const imported = parseConversation(conv);
    if (imported) {
      results.push(imported);
    }
  }

  return results;
}

/**
 * Walk the message tree for a single conversation: start at `current_node`,
 * follow `parent` pointers to root, then reverse to get chronological order.
 * Filter to user/assistant roles and convert to ContentBlock format.
 */
function parseConversation(conv: ChatGPTConversation): ImportedConversation | null {
  const { mapping, current_node } = conv;

  if (!mapping || !current_node || !mapping[current_node]) {
    return null;
  }

  // Walk from current_node to root via parent pointers
  const nodeIds: string[] = [];
  let nodeId: string | null = current_node;
  while (nodeId) {
    nodeIds.push(nodeId);
    nodeId = mapping[nodeId]?.parent ?? null;
  }
  nodeIds.reverse(); // Now chronological: root → current

  const messages: ImportedMessage[] = [];
  for (const id of nodeIds) {
    const node = mapping[id];
    if (!node?.message) continue;

    const { author, content, create_time } = node.message;
    const role = author?.role;

    // Only keep user and assistant messages
    if (role !== 'user' && role !== 'assistant') continue;

    const text = extractText(content);
    if (!text) continue;

    messages.push({
      role,
      content: [{ type: 'text', text }],
      createdAt: create_time ? Math.round(create_time * 1000) : Math.round(conv.create_time * 1000),
    });
  }

  if (messages.length === 0) return null;

  const sourceId = conv.id ?? `${conv.title}-${conv.create_time}`;

  return {
    sourceId,
    title: conv.title || 'Untitled',
    createdAt: Math.round(conv.create_time * 1000),
    updatedAt: Math.round(conv.update_time * 1000),
    messages,
  };
}

/**
 * Extract text from a ChatGPT content object.
 * parts can contain strings, nulls, or objects (e.g. image asset_pointers).
 * We join all string parts, skipping non-string entries.
 */
function extractText(content: ChatGPTContent): string {
  if (!content?.parts) return '';
  const textParts = content.parts.filter((p): p is string => typeof p === 'string');
  return textParts.join('');
}

/**
 * Extract conversations.json from a ChatGPT export ZIP file.
 */
async function extractFromZip(zipPath: string): Promise<string> {
  const data = readFileSync(zipPath);
  try {
    return extractConversationsFromZipBuffer(data);
  } catch (err) {
    throw new Error(`Failed to extract conversations.json from ZIP: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Minimal ZIP parser to extract conversations.json from a ZIP buffer.
 * ZIP files have a central directory at the end that lists all files.
 * We look for the local file headers to find conversations.json.
 */
function extractConversationsFromZipBuffer(buffer: Buffer): string {
  // Find end of central directory record (EOCD)
  // Signature: 0x06054b50
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
    throw new Error('Invalid ZIP file: could not find end of central directory');
  }

  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  const centralDirEntries = buffer.readUInt16LE(eocdOffset + 10);

  // Walk central directory entries to find conversations.json
  let offset = centralDirOffset;
  for (let i = 0; i < centralDirEntries; i++) {
    // Central directory header signature: 0x02014b50
    if (
      buffer[offset] !== 0x50 ||
      buffer[offset + 1] !== 0x4b ||
      buffer[offset + 2] !== 0x01 ||
      buffer[offset + 3] !== 0x02
    ) {
      throw new Error('Invalid ZIP central directory entry');
    }

    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf-8');

    if (fileName === 'conversations.json' || fileName.endsWith('/conversations.json')) {
      return extractLocalFile(buffer, localHeaderOffset);
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error('conversations.json not found in ZIP file');
}

/**
 * Extract file data from a ZIP local file header.
 */
function extractLocalFile(buffer: Buffer, offset: number): string {
  // Local file header signature: 0x04034b50
  if (
    buffer[offset] !== 0x50 ||
    buffer[offset + 1] !== 0x4b ||
    buffer[offset + 2] !== 0x03 ||
    buffer[offset + 3] !== 0x04
  ) {
    throw new Error('Invalid ZIP local file header');
  }

  const compressionMethod = buffer.readUInt16LE(offset + 8);
  const compressedSize = buffer.readUInt32LE(offset + 18);
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);

  const dataOffset = offset + 30 + fileNameLength + extraLength;
  const fileData = buffer.subarray(dataOffset, dataOffset + compressedSize);

  if (compressionMethod === 0) {
    // Stored (no compression)
    return fileData.toString('utf-8');
  } else if (compressionMethod === 8) {
    // Deflated
    const { inflateRawSync } = require('node:zlib') as typeof import('node:zlib');
    const decompressed = inflateRawSync(fileData);
    return decompressed.toString('utf-8');
  } else {
    throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
  }
}
