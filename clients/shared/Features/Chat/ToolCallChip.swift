import SwiftUI
#if os(macOS)
import AppKit
#endif

public struct ToolCallChip: View {
    public let toolCall: ToolCallData
    /// Optional callback invoked when expanding a tool call whose content was truncated.
    /// The parent view can use this to trigger on-demand rehydration of the full content.
    public var onRehydrate: (() -> Void)?

    public init(toolCall: ToolCallData, onRehydrate: (() -> Void)? = nil) {
        self.toolCall = toolCall
        self.onRehydrate = onRehydrate
    }
    @State private var isExpanded = false
    /// Cached formatted input — computed once on first expand to avoid re-running
    /// `formatAllToolInput` on every SwiftUI render pass.
    @State private var cachedInputFull: String?
    /// Cached line count for the result text — avoids O(n) `components(separatedBy:)`
    /// array allocation on every SwiftUI render pass when the chip is expanded.
    @State private var cachedResultLineCount: Int?

    /// Parse a `<command_exit code="N" />` tag from the result string and return the exit code.
    static func parseExitCode(from result: String) -> Int? {
        // Match <command_exit code="N" /> where N is an integer
        guard let codeRange = result.range(of: #"<command_exit code="(\d+)" />"#, options: .regularExpression) else {
            return nil
        }
        let matched = String(result[codeRange])
        // Extract the numeric code
        guard let numRange = matched.range(of: #"\d+"#, options: .regularExpression) else {
            return nil
        }
        return Int(matched[numRange])
    }

    /// Whether the tool produces diff-formatted output that benefits from line-level highlighting.
    static func isFileEditTool(_ name: String) -> Bool {
        switch name {
        case "file_edit", "host_file_edit", "app_file_edit": return true
        default: return false
        }
    }

    /// Human-readable explanation for common exit codes.
    static func exitCodeExplanation(_ code: Int) -> String? {
        switch code {
        case 1:   return "General error or no results found."
        case 2:   return "Misuse of shell built-in or invalid arguments."
        case 126: return "Command found but not executable (permission problem)."
        case 127: return "Command not found. It may not be installed."
        case 128: return "Invalid exit argument."
        case 130: return "Process terminated by Ctrl+C (SIGINT)."
        case 137: return "Process killed (SIGKILL), possibly out of memory."
        case 143: return "Process terminated (SIGTERM)."
        default:
            if code > 128 && code < 165 {
                return "Process terminated by signal \(code - 128)."
            }
            return nil
        }
    }

    private var hasExpandableContent: Bool {
        toolCall.result != nil || !toolCall.cachedImages.isEmpty
    }

    /// Counts newlines without allocating N substrings.
    /// Equivalent to `text.components(separatedBy: "\n").count` but O(1) memory.
    static func countLines(in text: String) -> Int {
        var count = 1
        for byte in text.utf8 where byte == 0x0A { count += 1 }
        return count
    }

    /// Lazily resolved full input text, using the cached value when available.
    private var resolvedInputFull: String {
        if let cached = cachedInputFull { return cached }
        if !toolCall.inputFull.isEmpty { return toolCall.inputFull }
        return ""
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Chip header (always visible)
            Button {
                if toolCall.isComplete && hasExpandableContent {
                    withAnimation(VAnimation.fast) { isExpanded.toggle() }
                }
            } label: {
                HStack(spacing: VSpacing.xs) {
                    // Tool-specific icon
                    VIconView(toolCall.toolIcon, size: 12)
                        .foregroundStyle(toolCall.isError ? VColor.systemNegativeStrong : VColor.contentSecondary)

                    // Plain-language description of what was done
                    Text(toolCall.actionDescription)
                        .font(VFont.labelDefault)
                        .foregroundStyle(toolCall.isError ? VColor.systemNegativeStrong : VColor.contentDefault)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .help(toolCall.actionDescription)

                    // Status indicator
                    if !toolCall.isComplete {
                        // Spinning indicator for in-progress
                        ProgressView()
                            .scaleEffect(0.6)
                            .frame(width: 14, height: 14)
                    } else if hasExpandableContent {
                        // Chevron for expandable result
                        VIconView(isExpanded ? .chevronDown : .chevronRight, size: 9)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                }
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.md)
                .contentShape(RoundedRectangle(cornerRadius: VRadius.md))
            }
            .buttonStyle(.plain)
            .pointerCursor()

            // Expanded details
            if isExpanded, hasExpandableContent {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Divider()
                        .padding(.horizontal, VSpacing.sm)

                    // Technical details section
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Technical details")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                            .textCase(.uppercase)

                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text(toolCall.friendlyName)
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentSecondary)
                            if !resolvedInputFull.isEmpty {
                                Text(resolvedInputFull)
                                    .font(VFont.bodySmallDefault)
                                    .foregroundStyle(VColor.contentSecondary)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .padding(.horizontal, VSpacing.sm)

                    // Image preview (for browser_screenshot, image generation etc.)
                    ForEach(Array(toolCall.cachedImages.enumerated()), id: \.offset) { _, cachedImage in
                        #if os(macOS)
                        let canOpenImage = !toolCall.inputRawValue.isEmpty
                            && FileManager.default.fileExists(atPath: toolCall.inputRawValue)
                        if canOpenImage {
                            Image(nsImage: cachedImage)
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(maxWidth: .infinity)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                                .padding(.horizontal, VSpacing.sm)
                                .onTapGesture(count: 2) {
                                    NSWorkspace.shared.open(URL(fileURLWithPath: toolCall.inputRawValue))
                                }
                                .pointerCursor()
                        } else {
                            Image(nsImage: cachedImage)
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(maxWidth: .infinity)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                                .padding(.horizontal, VSpacing.sm)
                        }
                        #elseif os(iOS)
                        Image(uiImage: cachedImage)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxWidth: .infinity)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                            .padding(.horizontal, VSpacing.sm)
                        #endif
                    }

                    // Output section
                    if let result = toolCall.result {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Output")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentTertiary)
                                .textCase(.uppercase)

                            if let exitCode = Self.parseExitCode(from: result) {
                                // Structured display for command exit codes
                                VStack(alignment: .leading, spacing: VSpacing.xs) {
                                    HStack(spacing: VSpacing.xs) {
                                        VIconView(.triangleAlert, size: 11)
                                            .foregroundStyle(VColor.systemNegativeStrong)
                                        Text("Exit code \(exitCode)")
                                            .font(VFont.labelDefault)
                                            .foregroundStyle(VColor.systemNegativeStrong)
                                    }
                                    if let explanation = Self.exitCodeExplanation(exitCode) {
                                        Text(explanation)
                                            .font(VFont.labelDefault)
                                            .foregroundStyle(VColor.contentSecondary)
                                    }
                                    // Show any additional output beyond the tag itself
                                    let extraOutput = result
                                        .replacingOccurrences(of: #"<command_exit code="\d+" />"#, with: "", options: .regularExpression)
                                        .trimmingCharacters(in: .whitespacesAndNewlines)
                                    if !extraOutput.isEmpty {
                                        Text(extraOutput)
                                            .font(VFont.bodySmallDefault)
                                            .foregroundStyle(VColor.contentSecondary)
                                            .textSelection(.enabled)
                                    }
                                }
                            } else if result == "<command_completed />" {
                                HStack(spacing: VSpacing.xs) {
                                    VIconView(.circleCheck, size: 11)
                                        .foregroundStyle(VColor.primaryBase)
                                    Text("Command completed successfully (no output).")
                                        .font(VFont.labelDefault)
                                        .foregroundStyle(VColor.contentSecondary)
                                }
                            } else {
                                let lineCount = cachedResultLineCount ?? Self.countLines(in: result)
                                if Self.isFileEditTool(toolCall.toolName) {
                                    VDiffView(result, maxHeight: lineCount > 500 ? 400 : nil)
                                } else {
                                    ScrollView {
                                        Text(result)
                                            .font(VFont.bodySmallDefault)
                                            .foregroundStyle(VColor.contentSecondary)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .textSelection(.enabled)
                                    }
                                    .adaptiveScrollFrame(for: result, maxHeight: 400)
                                }
                            }
                        }
                        .padding(.horizontal, VSpacing.sm)
                    }
                }
                .padding(.bottom, VSpacing.sm)
                .transition(.opacity)
                .onAppear {
                    // Compute formatted input once when the user first expands,
                    // rather than re-running formatAllToolInput on every render.
                    if cachedInputFull == nil {
                        if !toolCall.inputFull.isEmpty {
                            cachedInputFull = toolCall.inputFull
                        } else if let dict = toolCall.inputRawDict {
                            cachedInputFull = ToolCallData.formatAllToolInput(dict)
                        }
                    }
                    // Cache the result line count so subsequent renders are O(1).
                    if cachedResultLineCount == nil, let result = toolCall.result {
                        cachedResultLineCount = Self.countLines(in: result)
                    }
                    // Trigger on-demand rehydration when expanding truncated content.
                    onRehydrate?()
                }
            }
        }
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(toolCall.isError
                    ? VColor.systemNegativeStrong.opacity(0.08)
                    : VColor.borderBase.opacity(0.3))
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(toolCall.isError
                    ? VColor.systemNegativeStrong.opacity(0.3)
                    : VColor.borderBase.opacity(0.5), lineWidth: 0.5)
        )
        .onChange(of: isExpanded) { _, newValue in
            // Populate the cache *before* the expanded body evaluates so that
            // `resolvedInputFull` returns the formatted input on the very first
            // render of the expanded section — avoiding a visible flash/pop-in
            // for lazy-loaded history tool calls where `.onAppear` fires too late.
            if newValue {
                if cachedInputFull == nil {
                    if let dict = toolCall.inputRawDict {
                        cachedInputFull = ToolCallData.formatAllToolInput(dict)
                    } else if !toolCall.inputFull.isEmpty {
                        cachedInputFull = toolCall.inputFull
                    }
                }
                if cachedResultLineCount == nil, let result = toolCall.result {
                    cachedResultLineCount = Self.countLines(in: result)
                }
            }
        }
        .onChange(of: toolCall.inputFull) {
            // Invalidate the cached formatted input so the next render picks up
            // the fresh (rehydrated) value instead of the stale truncated one.
            cachedInputFull = nil
        }
        .onChange(of: toolCall.result) {
            if isExpanded, let result = toolCall.result {
                cachedResultLineCount = Self.countLines(in: result)
            } else {
                cachedResultLineCount = nil
            }
        }
    }
}
