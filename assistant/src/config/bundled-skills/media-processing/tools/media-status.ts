import {
  getMediaAssetByFilePath,
  getMediaAssetById,
  getMediaAssetsByStatus,
  getProcessingStagesForAsset,
  type MediaAssetStatus,
} from "../../../../memory/media-store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const assetId = input.asset_id as string | undefined;
  const filePath = input.file_path as string | undefined;
  const statusFilter = input.status_filter as MediaAssetStatus | undefined;

  // Query by asset ID
  if (assetId) {
    const asset = getMediaAssetById(assetId);
    if (!asset) {
      return { content: `Media asset not found: ${assetId}`, isError: true };
    }
    const stages = getProcessingStagesForAsset(asset.id);
    return {
      content: JSON.stringify({ asset, stages }, null, 2),
      isError: false,
    };
  }

  // Query by file path
  if (filePath) {
    const asset = getMediaAssetByFilePath(filePath);
    if (!asset) {
      return {
        content: `No media asset found for path: ${filePath}`,
        isError: true,
      };
    }
    const stages = getProcessingStagesForAsset(asset.id);
    return {
      content: JSON.stringify({ asset, stages }, null, 2),
      isError: false,
    };
  }

  // Query by status filter
  if (statusFilter) {
    const validStatuses: MediaAssetStatus[] = [
      "registered",
      "processing",
      "indexed",
      "failed",
    ];
    if (!validStatuses.includes(statusFilter)) {
      return {
        content: `Invalid status filter: ${statusFilter}. Valid values: ${validStatuses.join(", ")}`,
        isError: true,
      };
    }
    const assets = getMediaAssetsByStatus(statusFilter);
    const results = assets.map((asset) => ({
      asset,
      stages: getProcessingStagesForAsset(asset.id),
    }));
    return {
      content: JSON.stringify(
        {
          count: results.length,
          assets: results,
        },
        null,
        2,
      ),
      isError: false,
    };
  }

  return {
    content:
      "Provide at least one query parameter: asset_id, file_path, or status_filter.",
    isError: true,
  };
}
