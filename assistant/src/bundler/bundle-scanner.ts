/**
 * BundleScanner — Security validation and static analysis for .vellumapp bundles.
 *
 * Validates zip bundles before they are opened, returning structured results
 * with block-level (reject) and warn-level (flag) findings.
 */

import JSZip from "jszip";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScanFinding {
  category: "archive" | "html" | "asset";
  code: string;
  message: string;
  level: "block" | "warn";
}

export interface ScanResult {
  passed: boolean;
  findings: ScanFinding[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DECOMPRESSED_SIZE = 25 * 1024 * 1024; // 25 MB
const MAX_FILE_COUNT = 50;
const MAX_COMPRESSION_RATIO = 100;
const OBFUSCATION_LINE_LENGTH = 10_000; // 10 KB single line threshold

const BLOCKED_EXTENSIONS = new Set([
  ".exe",
  ".sh",
  ".command",
  ".app",
  ".dylib",
  ".so",
  ".scpt",
]);

const REQUIRED_MANIFEST_FIELDS = [
  "format_version",
  "name",
  "created_at",
  "created_by",
  "entry",
  "capabilities",
] as const;

// Magic byte signatures for image validation
const IMAGE_SIGNATURES: Record<string, { bytes: number[]; offset?: number }[]> = {
  ".png": [{ bytes: [0x89, 0x50, 0x4e, 0x47] }], // \x89PNG
  ".jpg": [{ bytes: [0xff, 0xd8, 0xff] }],
  ".jpeg": [{ bytes: [0xff, 0xd8, 0xff] }],
  ".gif": [{ bytes: [0x47, 0x49, 0x46, 0x38] }], // GIF8
  ".webp": [
    { bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF at offset 0
    // bytes 8-11 should be WEBP — checked separately
  ],
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function scanBundle(zipPath: string): Promise<ScanResult> {
  const findings: ScanFinding[] = [];

  const fileData = await Bun.file(zipPath).arrayBuffer();
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fileData);
  } catch {
    findings.push({
      category: "archive",
      code: "invalid_zip",
      message: "File is not a valid zip archive",
      level: "block",
    });
    return { passed: false, findings };
  }

  // Run all scan phases
  const manifest = await scanArchiveStructure(zip, fileData.byteLength, findings);
  if (manifest) {
    await scanHtmlEntry(zip, manifest.entry as string, findings);
  }
  const entryName = manifest ? (manifest.entry as string | undefined) : undefined;
  await scanAssets(zip, findings, entryName);

  const passed = !findings.some((f) => f.level === "block");
  return { passed, findings };
}

// ---------------------------------------------------------------------------
// Phase 1: Archive structure scan
// ---------------------------------------------------------------------------

async function scanArchiveStructure(
  zip: JSZip,
  compressedSize: number,
  findings: ScanFinding[],
): Promise<Record<string, unknown> | null> {
  const entries = Object.keys(zip.files);
  const fileEntries = entries.filter((e) => !zip.files[e].dir);

  // File count check
  if (fileEntries.length > MAX_FILE_COUNT) {
    findings.push({
      category: "archive",
      code: "too_many_files",
      message: `Bundle contains ${fileEntries.length} files (max ${MAX_FILE_COUNT})`,
      level: "block",
    });
  }

  // Path traversal & blocked extensions
  for (const name of entries) {
    if (name.includes("../") || name.startsWith("/")) {
      findings.push({
        category: "archive",
        code: "path_traversal",
        message: `Zip entry contains path traversal: ${name}`,
        level: "block",
      });
    }

    const lowerName = name.toLowerCase();
    for (const ext of BLOCKED_EXTENSIONS) {
      if (lowerName.endsWith(ext)) {
        findings.push({
          category: "archive",
          code: "blocked_file_type",
          message: `Blocked file type ${ext}: ${name}`,
          level: "block",
        });
        break;
      }
    }
  }

  // Compute total decompressed size and compression ratio (bail out early to
  // avoid decompressing the entire archive if limits are exceeded).
  let totalDecompressed = 0;
  for (const name of fileEntries) {
    const entry = zip.files[name];
    const data = await entry.async("uint8array");
    totalDecompressed += data.byteLength;
    if (totalDecompressed > MAX_DECOMPRESSED_SIZE) break;
    if (compressedSize > 0 && totalDecompressed / compressedSize > MAX_COMPRESSION_RATIO) break;
  }

  if (totalDecompressed > MAX_DECOMPRESSED_SIZE) {
    findings.push({
      category: "archive",
      code: "too_large",
      message: `Total decompressed size ${(totalDecompressed / 1024 / 1024).toFixed(1)} MB exceeds ${MAX_DECOMPRESSED_SIZE / 1024 / 1024} MB limit`,
      level: "block",
    });
  }

  if (compressedSize > 0 && totalDecompressed / compressedSize > MAX_COMPRESSION_RATIO) {
    findings.push({
      category: "archive",
      code: "zip_bomb",
      message: `Compression ratio ${(totalDecompressed / compressedSize).toFixed(0)}:1 exceeds ${MAX_COMPRESSION_RATIO}:1 limit`,
      level: "block",
    });
  }

  // Manifest validation
  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) {
    findings.push({
      category: "archive",
      code: "manifest_missing",
      message: "manifest.json is missing from the bundle",
      level: "block",
    });
    return null;
  }

  let manifest: Record<string, unknown>;
  try {
    const manifestText = await manifestFile.async("text");
    manifest = JSON.parse(manifestText) as Record<string, unknown>;
  } catch {
    findings.push({
      category: "archive",
      code: "manifest_malformed",
      message: "manifest.json is not valid JSON",
      level: "block",
    });
    return null;
  }

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!(field in manifest)) {
      findings.push({
        category: "archive",
        code: "manifest_malformed",
        message: `manifest.json is missing required field: ${field}`,
        level: "block",
      });
    }
  }

  // Entry file check
  const entryName = manifest.entry;
  if (typeof entryName === "string" && !zip.file(entryName)) {
    findings.push({
      category: "archive",
      code: "entry_missing",
      message: `Entry file "${entryName}" specified in manifest is missing`,
      level: "block",
    });
  }

  return manifest;
}

// ---------------------------------------------------------------------------
// Phase 2: HTML / JS static analysis
// ---------------------------------------------------------------------------

async function scanHtmlEntry(
  zip: JSZip,
  entryName: string,
  findings: ScanFinding[],
): Promise<void> {
  const entryFile = zip.file(entryName);
  if (!entryFile) return;

  const html = await entryFile.async("text");

  // --- Block-level: external resource references ---

  // <script src="..."> with external origin (quoted and unquoted)
  const scriptSrcRe = /<script[^>]+src\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/gi;
  for (const m of html.matchAll(scriptSrcRe)) {
    const url = m[1] ?? m[2];
    if (isExternalUrl(url)) {
      findings.push({
        category: "html",
        code: "external_script",
        message: `External script source: ${url}`,
        level: "block",
      });
    }
  }

  // <link href="..."> with external origin (quoted and unquoted)
  const linkHrefRe = /<link[^>]+href\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/gi;
  for (const m of html.matchAll(linkHrefRe)) {
    const url = m[1] ?? m[2];
    if (isExternalUrl(url)) {
      findings.push({
        category: "html",
        code: "external_link",
        message: `External link href: ${url}`,
        level: "block",
      });
    }
  }

  // <iframe src="..."> with external origin (quoted and unquoted)
  const iframeSrcRe = /<iframe[^>]+src\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/gi;
  for (const m of html.matchAll(iframeSrcRe)) {
    const url = m[1] ?? m[2];
    if (isExternalUrl(url)) {
      findings.push({
        category: "html",
        code: "external_iframe",
        message: `External iframe source: ${url}`,
        level: "block",
      });
    }
  }

  // <meta http-equiv="refresh"> with external URL
  const metaRefreshRe = /<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]+content\s*=\s*["'][^"']*url\s*=\s*([^"'\s;]+)/gi;
  for (const m of html.matchAll(metaRefreshRe)) {
    if (isExternalUrl(m[1])) {
      findings.push({
        category: "html",
        code: "external_meta_refresh",
        message: `Meta refresh redirects to external URL: ${m[1]}`,
        level: "block",
      });
    }
  }

  // --- Warn-level: suspicious JS patterns ---

  const warnPatterns: { pattern: RegExp; code: string; message: string }[] = [
    { pattern: /\bfetch\s*\(/g, code: "network_fetch", message: "Use of fetch() detected" },
    { pattern: /\bXMLHttpRequest\b/g, code: "network_xhr", message: "Use of XMLHttpRequest detected" },
    { pattern: /\bnew\s+WebSocket\b/g, code: "network_websocket", message: "Use of WebSocket detected" },
    { pattern: /\bEventSource\b/g, code: "network_eventsource", message: "Use of EventSource detected" },
    { pattern: /\bdocument\.cookie\b/g, code: "cookie_access", message: "Access to document.cookie detected" },
    { pattern: /\beval\s*\(/g, code: "eval_usage", message: "Use of eval() detected" },
    { pattern: /\bFunction\s*\(/g, code: "function_constructor", message: "Use of Function() constructor detected" },
    {
      pattern: /\bsetTimeout\s*\(\s*["'`]/g,
      code: "settimeout_string",
      message: "setTimeout with string argument detected",
    },
    {
      pattern: /\bsetInterval\s*\(\s*["'`]/g,
      code: "setinterval_string",
      message: "setInterval with string argument detected",
    },
    { pattern: /\bwindow\.open\s*\(/g, code: "window_open", message: "Use of window.open() detected" },
    {
      pattern: /\bwindow\.location\s*=/g,
      code: "window_location_assign",
      message: "Assignment to window.location detected",
    },
  ];

  for (const { pattern, code, message } of warnPatterns) {
    if (pattern.test(html)) {
      findings.push({ category: "html", code, message, level: "warn" });
    }
  }

  // Obfuscation detection: single lines > 10KB or high hex/unicode escape density
  const lines = html.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > OBFUSCATION_LINE_LENGTH) {
      findings.push({
        category: "html",
        code: "obfuscated_js",
        message: `Possible obfuscated JS: line ${i + 1} is ${(line.length / 1024).toFixed(1)} KB`,
        level: "warn",
      });
      break; // one finding is enough
    }
  }

  // High density of hex/unicode escapes
  const escapeMatches = html.match(/\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\}/g);
  if (escapeMatches && escapeMatches.length > 50) {
    findings.push({
      category: "html",
      code: "obfuscated_js",
      message: `High density of hex/unicode escapes detected (${escapeMatches.length} occurrences)`,
      level: "warn",
    });
  }
}

function isExternalUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://") || url.startsWith("//");
}

// ---------------------------------------------------------------------------
// Phase 3: Asset scan
// ---------------------------------------------------------------------------

async function scanAssets(zip: JSZip, findings: ScanFinding[], manifestEntry?: string): Promise<void> {
  const allowedRootFiles = new Set(["index.html", "manifest.json", "signature.json"]);
  if (manifestEntry) {
    allowedRootFiles.add(manifestEntry);
  }

  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;

    // Double extension check — only flag when a known content/media extension
    // appears before the final extension (e.g. file.jpg.exe, file.png.sh),
    // which is a common technique to disguise executables. Legitimate multi-dot
    // filenames like app.min.js or vendor.module.css are not flagged.
    const basename = name.split("/").pop() ?? name;
    const dotParts = basename.split(".");
    if (dotParts.length > 2) {
      const suspiciousInnerExts = new Set([
        "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico",
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
        "html", "htm", "txt", "rtf", "zip", "tar", "gz",
      ]);
      // Check if any non-final extension segment is a known content type
      const innerParts = dotParts.slice(1, -1); // extensions between first dot and last dot
      const hasSuspiciousInner = innerParts.some((p) => suspiciousInnerExts.has(p.toLowerCase()));
      if (hasSuspiciousInner) {
        findings.push({
          category: "asset",
          code: "double_extension",
          message: `File has suspicious double extension: ${name}`,
          level: "block",
        });
      }
    }

    // Files outside assets/ that aren't allowed root files
    if (!name.startsWith("assets/") && !allowedRootFiles.has(name)) {
      findings.push({
        category: "asset",
        code: "unexpected_file",
        message: `Unexpected file outside assets/ directory: ${name}`,
        level: "warn",
      });
    }

    // Magic bytes validation for image files
    const ext = getExtension(name);
    const signatures = IMAGE_SIGNATURES[ext];
    if (signatures) {
      const data = await entry.async("uint8array");
      const valid = validateImageMagicBytes(data, ext);
      if (!valid) {
        findings.push({
          category: "asset",
          code: "magic_bytes_mismatch",
          message: `File ${name} has extension ${ext} but magic bytes don't match`,
          level: "block",
        });
      }
    }

    // SVG: should start with < or <?xml
    if (ext === ".svg") {
      const data = await entry.async("text");
      const trimmed = data.trimStart();
      if (!trimmed.startsWith("<")) {
        findings.push({
          category: "asset",
          code: "magic_bytes_mismatch",
          message: `File ${name} has extension .svg but does not appear to be valid SVG`,
          level: "block",
        });
      }
    }
  }
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "";
  return name.slice(dot).toLowerCase();
}

function validateImageMagicBytes(data: Uint8Array, ext: string): boolean {
  const sigs = IMAGE_SIGNATURES[ext];
  if (!sigs) return true;

  // Check primary signature
  const primary = sigs[0];
  if (data.length < primary.bytes.length) return false;
  for (let i = 0; i < primary.bytes.length; i++) {
    if (data[i] !== primary.bytes[i]) return false;
  }

  // WebP needs additional check: bytes 8-11 should be "WEBP"
  if (ext === ".webp") {
    if (data.length < 12) return false;
    const webp = [0x57, 0x45, 0x42, 0x50]; // WEBP
    for (let i = 0; i < 4; i++) {
      if (data[8 + i] !== webp[i]) return false;
    }
  }

  return true;
}
