export type CommandCategory =
  | "test-runner"
  | "git-diff"
  | "git-status"
  | "directory-listing"
  | "search-results"
  | "build-lint"
  | "unknown";

export interface CompressionResult {
  compressed: string;
  originalLength: number;
  compressedLength: number;
  category: CommandCategory;
  wasCompressed: boolean;
}
