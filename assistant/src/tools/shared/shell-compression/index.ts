import { compressBuildOutput } from "./compressors/build-lint.js";
import { compressDirectoryListing } from "./compressors/directory-listing.js";
import { compressGitDiff } from "./compressors/git-diff.js";
import { compressGitStatus } from "./compressors/git-status.js";
import { compressSearchResults } from "./compressors/search-results.js";
import { compressTestOutput } from "./compressors/test-runner.js";
import { detectCommand } from "./detect-command.js";
import type { CompressionResult } from "./types.js";

/** Minimum output length before compression is attempted. */
const MIN_LENGTH = 2000;

/**
 * Compress shell command output using command-aware compression.
 *
 * Detects the command type and routes to the appropriate compressor.
 * Returns a passthrough result for short output, unknown commands,
 * or when no compression is beneficial.
 */
export function compressShellOutput(
  command: string,
  stdout: string,
  stderr: string,
  exitCode: number | null,
): CompressionResult {
  const originalLength = stdout.length + stderr.length;

  if (originalLength < MIN_LENGTH) {
    return {
      compressed: "",
      originalLength,
      compressedLength: originalLength,
      category: "unknown",
      wasCompressed: false,
    };
  }

  const { category } = detectCommand(command);

  if (category === "unknown") {
    return {
      compressed: "",
      originalLength,
      compressedLength: originalLength,
      category,
      wasCompressed: false,
    };
  }

  let compressed: string;

  switch (category) {
    case "test-runner":
      compressed = compressTestOutput(stdout, stderr, exitCode);
      break;
    case "git-diff":
      compressed = compressGitDiff(stdout, stderr, exitCode);
      break;
    case "git-status":
      compressed = compressGitStatus(stdout, stderr, exitCode);
      break;
    case "directory-listing":
      compressed = compressDirectoryListing(stdout, stderr, exitCode);
      break;
    case "search-results":
      compressed = compressSearchResults(stdout, stderr, exitCode);
      break;
    case "build-lint":
      compressed = compressBuildOutput(stdout, stderr, exitCode);
      break;
  }

  const compressedLength = compressed.length;

  // Guard against empty compression results — a compressor returning empty
  // string would replace real output with nothing.
  if (!compressed.trim() || compressedLength >= originalLength) {
    return {
      compressed: "",
      originalLength,
      compressedLength: originalLength,
      category,
      wasCompressed: false,
    };
  }

  return {
    compressed,
    originalLength,
    compressedLength,
    category,
    wasCompressed: true,
  };
}
