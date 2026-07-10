import {
  type ContentBlock,
  resolveMediaSourceData,
} from "@vellumai/plugin-api";

/**
 * Media-block extraction over stored message content (a JSON content-block
 * array), for the plugin's media indexing and embedding paths. Parses via the
 * contract's `ContentBlock` shape; byte resolution goes through the blessed
 * `resolveMediaSourceData`, which for workspace-reference sources is an
 * attachment-store read (DB row + file on disk) — so `extractMediaBlocks`
 * must run at runtime against a ready database. `extractMediaBlockMeta` is
 * the pure variant.
 */

/** Image blocks in stored message content, with their bytes resolved. */
export function extractMediaBlocks(raw: string): Array<{
  type: "image";
  data: Buffer;
  mimeType: string;
  index: number;
}> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const results: Array<{
      type: "image";
      data: Buffer;
      mimeType: string;
      index: number;
    }> = [];
    for (let i = 0; i < parsed.length; i++) {
      const block = parsed[i] as ContentBlock;
      if (block.type === "image") {
        // The source may be inline base64 or a workspace reference;
        // resolveMediaSourceData resolves both to base64 bytes.
        const resolved = resolveMediaSourceData(block.source);
        if (!resolved) {
          continue;
        }
        results.push({
          type: "image" as const,
          data: Buffer.from(resolved.data, "base64"),
          mimeType: resolved.media_type,
          index: i,
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Lightweight variant of extractMediaBlocks that returns only type and index
 * metadata without resolving image bytes.
 */
export function extractMediaBlockMeta(
  raw: string,
): Array<{ type: "image"; index: number }> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const results: Array<{ type: "image"; index: number }> = [];
    for (let i = 0; i < parsed.length; i++) {
      const block = parsed[i] as { type?: string };
      if (block.type === "image") {
        results.push({ type: "image" as const, index: i });
      }
    }
    return results;
  } catch {
    return [];
  }
}
