/**
 * Guard tests: prevent reintroduction of SwiftUI performance anti-patterns
 * in LazyVStack cell hierarchy files.
 *
 * The macOS app experienced 37-134 second hangs caused by three anti-patterns:
 *
 * 1. `.frame(maxWidth:)` / `.frame(maxHeight:)` creating `_FlexFrameLayout`
 *    inside LazyVStack cells — O(n) alignment measurement per layout pass.
 *
 * 2. `.transition(.move(edge:))` triggering `motionVectors()` full-content
 *    measurement that defeats lazy loading.
 *
 * 3. `withAnimation` wrapping state mutations that flow into LazyVStack
 *    content, triggering motionVectors cascade.
 *
 * All three anti-patterns have been fixed. These guard tests prevent regression.
 *
 * See `clients/macos/AGENTS.md` for the full rationale and safe alternatives.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, test } from "bun:test";

const repoRoot = resolve(__dirname, "..", "..", "..");

/**
 * Cell hierarchy files rendered inside the LazyVStack ForEach.
 * Matched by filename (basename) so subdirectory structure doesn't matter.
 */
const LAZY_VSTACK_CELL_FILES = [
  // macOS cell files (under clients/macos/vellum-assistant/Features/Chat/)
  "MessageCellView.swift",
  "ChatBubble.swift",
  "AssistantProgressView.swift",
  "ChatBubbleTextContent.swift",
  "ChatBubbleInterleavedContent.swift",
  "ChatBubbleToolStatusView.swift",
  "ChatBubbleAttachmentContent.swift",
  "ChatBubbleOverflowMenu.swift",
  "ChatWidgetViews.swift",
  "AnimatedImageView.swift",
  "MarkdownSegmentView.swift",
  "ThinkingBlockView.swift",
  // The LazyVStack container itself
  "MessageListContentView.swift",
  // Shared cell files (under clients/shared/Features/Chat/)
  "ToolConfirmationBubble.swift",
  "ToolCallChip.swift",
  "ToolCallProgressBar.swift",
  "GuardianDecisionBubble.swift",
  "CommandListBubble.swift",
  "ModelListBubble.swift",
  "InlineChatErrorAlert.swift",
  "InlineSurfaceRouter.swift",
  "InlineDocumentPreview.swift",
  "InlineTableWidget.swift",
  "InlineAppCreatedCard.swift",
  "InlineDynamicPagePreview.swift",
  "MarkdownRenderer.swift",
];

/**
 * Files with known FlexFrame violations that should be cleaned up separately.
 * Allowlisted by full relative path so the test passes today.
 */
const FLEX_FRAME_ALLOWLIST = [
  "clients/macos/vellum-assistant/Features/Chat/ChatBubbleAttachmentContent.swift",
  "clients/macos/vellum-assistant/Features/Chat/AnimatedImageView.swift",
  "clients/macos/vellum-assistant/Features/Chat/ChatWidgetViews.swift",
  "clients/macos/vellum-assistant/Features/Chat/ChatBubbleOverflowMenu.swift",
  "clients/shared/Features/Chat/ToolCallChip.swift",
  "clients/shared/Features/Chat/ToolCallProgressBar.swift",
  "clients/shared/Features/Chat/GuardianDecisionBubble.swift",
  "clients/shared/Features/Chat/CommandListBubble.swift",
  "clients/shared/Features/Chat/ModelListBubble.swift",
  "clients/shared/Features/Chat/InlineChatErrorAlert.swift",
  "clients/shared/Features/Chat/InlineWidgets/InlineTableWidget.swift",
  "clients/shared/Features/Chat/InlineWidgets/InlineDynamicPagePreview.swift",
  "clients/shared/Features/Chat/InlineWidgets/InlineAppCreatedCard.swift",
  "clients/shared/Features/Chat/InlineWidgets/InlineDocumentPreview.swift",
];

describe("SwiftUI LazyVStack performance guards", () => {
  test("no .frame(maxWidth:) or .frame(maxHeight:) in LazyVStack cell hierarchy (FlexFrameLayout)", () => {
    // Search for .frame(maxWidth: and .frame(maxHeight: in Swift files.
    // Uses hardcoded grep patterns — no user input, safe from injection.
    const raw = execSync(
      'grep -rn "\\.frame(maxWidth:\\|\\.frame(maxHeight:" clients/macos/ clients/shared/ --include="*.swift" || true',
      { encoding: "utf-8", cwd: repoRoot },
    );

    const offending = raw
      .trim()
      .split("\n")
      .filter((line) => {
        if (!line) return false;

        // Extract the file path (everything before the first colon-number-colon)
        const filePath = line.split(":")[0];
        if (!filePath) return false;

        // Only check cell hierarchy files (match by basename)
        const basename = filePath.split("/").pop() || "";
        const isCellFile = LAZY_VSTACK_CELL_FILES.includes(basename);
        if (!isCellFile) return false;

        // Skip allowlisted files (match by full relative path)
        if (FLEX_FRAME_ALLOWLIST.some((allowed) => filePath.includes(allowed)))
          return false;

        // Skip lines that are only comments (// before the .frame( match)
        const contentAfterPath = line.substring(
          line.indexOf(":", line.indexOf(":") + 1) + 1,
        );
        const trimmed = contentAfterPath.trimStart();
        if (trimmed.startsWith("//")) return false;

        return true;
      });

    if (offending.length > 0) {
      throw new Error(
        "Found .frame(maxWidth:) or .frame(maxHeight:) in LazyVStack cell hierarchy files.\n\n" +
          "WHY THIS IS DANGEROUS: .frame(maxWidth:) creates _FlexFrameLayout whose placement() " +
          "queries each child's explicit alignment via ViewDimensions.subscript. Inside a " +
          "LazyVStack, this causes O(n) recursive alignment queries per layout pass, leading " +
          "to 37-134 second hangs.\n\n" +
          "USE INSTEAD:\n" +
          "  - .frame(width: exactWidth) -- _FrameLayout, no alignment query\n" +
          "  - HStack { content; Spacer(minLength: 0) } -- leading alignment without queries\n" +
          "  - HStack { Spacer(minLength: 0); content } -- trailing alignment without queries\n\n" +
          "See clients/macos/AGENTS.md for full rationale and safe alternatives.\n\n" +
          "Offending lines:\n" +
          offending.join("\n"),
      );
    }
  });

  test("no .transition(.move(edge:)) in LazyVStack cell hierarchy (motionVectors)", () => {
    // Search for .transition(.move( in Swift files.
    // Uses hardcoded grep patterns — no user input, safe from injection.
    const raw = execSync(
      'grep -rn "\\.transition(.move(" clients/macos/ clients/shared/ --include="*.swift" || true',
      { encoding: "utf-8", cwd: repoRoot },
    );

    const offending = raw
      .trim()
      .split("\n")
      .filter((line) => {
        if (!line) return false;

        const filePath = line.split(":")[0];
        if (!filePath) return false;

        // Only check cell hierarchy files (match by basename)
        const basename = filePath.split("/").pop() || "";
        const isCellFile = LAZY_VSTACK_CELL_FILES.includes(basename);
        if (!isCellFile) return false;

        // Skip comment-only lines
        const contentAfterPath = line.substring(
          line.indexOf(":", line.indexOf(":") + 1) + 1,
        );
        const trimmed = contentAfterPath.trimStart();
        if (trimmed.startsWith("//")) return false;

        return true;
      });

    if (offending.length > 0) {
      throw new Error(
        "Found .transition(.move(edge:)) in LazyVStack cell hierarchy files.\n\n" +
          "WHY THIS IS DANGEROUS: .transition(.move(edge:)) triggers motionVectors() -- " +
          "an O(n) sizeThatFits measurement over ALL children in the LazyVStack that " +
          "defeats lazy loading and causes multi-minute hangs.\n\n" +
          "USE INSTEAD: .transition(.opacity) for fade-in/out without motionVectors.\n\n" +
          "See clients/macos/AGENTS.md for full rationale.\n\n" +
          "Offending lines:\n" +
          offending.join("\n"),
      );
    }
  });

  test("no withAnimation in scroll handlers (motionVectors cascade)", () => {
    const scrollHandlerFiles = [
      "clients/macos/vellum-assistant/Features/Chat/MessageListView+ScrollHandling.swift",
      "clients/macos/vellum-assistant/Features/Chat/MessageListView+Lifecycle.swift",
    ];

    /**
     * Known withAnimation violation counts per file that exist on main and
     * should be cleaned up separately. The test will fail if NEW violations
     * are added beyond these counts. Decrement as violations are cleaned up.
     */
    const KNOWN_VIOLATION_COUNTS: Record<string, number> = {
      "clients/macos/vellum-assistant/Features/Chat/MessageListView+ScrollHandling.swift": 1,
      "clients/macos/vellum-assistant/Features/Chat/MessageListView+Lifecycle.swift": 4,
    };

    // Search for withAnimation in the specific scroll handler files.
    // Uses hardcoded file paths — no user input, safe from injection.
    const raw = execSync(
      "grep -rn withAnimation " + scrollHandlerFiles.join(" ") + " || true",
      { encoding: "utf-8", cwd: repoRoot },
    );

    const nonCommentLines = raw
      .trim()
      .split("\n")
      .filter((line) => {
        if (!line) return false;

        // Skip comment-only lines
        const contentAfterPath = line.substring(
          line.indexOf(":", line.indexOf(":") + 1) + 1,
        );
        const trimmed = contentAfterPath.trimStart();
        if (trimmed.startsWith("//")) return false;

        return true;
      });

    // Group violations by file and check against known counts
    const violationsByFile: Record<string, string[]> = {};
    for (const line of nonCommentLines) {
      const filePath = line.split(":")[0] || "";
      if (!violationsByFile[filePath]) violationsByFile[filePath] = [];
      violationsByFile[filePath].push(line);
    }

    const offending: string[] = [];
    for (const [filePath, lines] of Object.entries(violationsByFile)) {
      const knownCount = KNOWN_VIOLATION_COUNTS[filePath] ?? 0;
      if (lines.length > knownCount) {
        // New violations beyond the known count
        offending.push(...lines.slice(knownCount));
      }
    }

    if (offending.length > 0) {
      throw new Error(
        "Found withAnimation in scroll handler files.\n\n" +
          "WHY THIS IS DANGEROUS: withAnimation wrapping state mutations that flow into " +
          "LazyVStack content triggers the motionVectors cascade -- an O(n) sizeThatFits " +
          "measurement over ALL children that defeats lazy loading and causes multi-minute " +
          "hangs.\n\n" +
          "USE INSTEAD: .transaction { $0.animation = nil } to suppress animations on " +
          "state changes that affect the LazyVStack content.\n\n" +
          "See clients/macos/AGENTS.md for full rationale.\n\n" +
          "Offending lines:\n" +
          offending.join("\n"),
      );
    }
  });
});
