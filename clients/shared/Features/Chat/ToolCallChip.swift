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

    /// Whether the tool result or input appears to contain truncated content.
    private var isTruncated: Bool {
        (toolCall.result?.hasSuffix("[truncated]") ?? false)
            || toolCall.inputFull.hasSuffix("[truncated]")
    }

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
        toolCall.result != nil || toolCall.cachedImage != nil
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
                        .foregroundColor(toolCall.isError ? VColor.error : VColor.textSecondary)

                    // Plain-language description of what was done
                    Text(toolCall.actionDescription)
                        .font(VFont.captionMedium)
                        .foregroundColor(toolCall.isError ? VColor.error : VColor.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    // Status indicator
                    if !toolCall.isComplete {
                        // Spinning indicator for in-progress
                        ProgressView()
                            .scaleEffect(0.6)
                            .frame(width: 14, height: 14)
                    } else if hasExpandableContent {
                        // Chevron for expandable result
                        VIconView(isExpanded ? .chevronDown : .chevronRight, size: 9)
                            .foregroundColor(VColor.textMuted)
                    }
                }
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
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
                        HStack {
                            Text("Technical details")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                                .textCase(.uppercase)
                            if isTruncated {
                                Text("truncated")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.warning)
                                    .padding(.horizontal, VSpacing.xs)
                                    .background(
                                        RoundedRectangle(cornerRadius: VRadius.xs)
                                            .fill(VColor.warning.opacity(0.12))
                                    )
                            }
                        }

                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text(toolCall.friendlyName)
                                .font(VFont.captionMedium)
                                .foregroundColor(VColor.textSecondary)
                            if !resolvedInputFull.isEmpty {
                                Text(resolvedInputFull)
                                    .font(VFont.monoSmall)
                                    .foregroundColor(VColor.textSecondary)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                    .padding(.horizontal, VSpacing.sm)

                    // Image preview (for browser_screenshot etc.)
                    if let cachedImage = toolCall.cachedImage {
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
                                .onHover { hovering in
                                    if hovering { NSCursor.pointingHand.push() }
                                    else { NSCursor.pop() }
                                }
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
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                                .textCase(.uppercase)

                            if let exitCode = Self.parseExitCode(from: result) {
                                // Structured display for command exit codes
                                VStack(alignment: .leading, spacing: VSpacing.xs) {
                                    HStack(spacing: VSpacing.xs) {
                                        VIconView(.triangleAlert, size: 11)
                                            .foregroundColor(VColor.error)
                                        Text("Exit code \(exitCode)")
                                            .font(VFont.captionMedium)
                                            .foregroundColor(VColor.error)
                                    }
                                    if let explanation = Self.exitCodeExplanation(exitCode) {
                                        Text(explanation)
                                            .font(VFont.caption)
                                            .foregroundColor(VColor.textSecondary)
                                    }
                                    // Show any additional output beyond the tag itself
                                    let extraOutput = result
                                        .replacingOccurrences(of: #"<command_exit code="\d+" />"#, with: "", options: .regularExpression)
                                        .trimmingCharacters(in: .whitespacesAndNewlines)
                                    if !extraOutput.isEmpty {
                                        Text(extraOutput)
                                            .font(VFont.monoSmall)
                                            .foregroundColor(VColor.textSecondary)
                                            .textSelection(.enabled)
                                    }
                                }
                            } else if result == "<command_completed />" {
                                HStack(spacing: VSpacing.xs) {
                                    VIconView(.circleCheck, size: 11)
                                        .foregroundColor(VColor.accent)
                                    Text("Command completed successfully (no output).")
                                        .font(VFont.caption)
                                        .foregroundColor(VColor.textSecondary)
                                }
                            } else {
                                ScrollView {
                                    Text(result)
                                        .font(VFont.monoSmall)
                                        .foregroundColor(VColor.textSecondary)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .textSelection(.enabled)
                                }
                                .frame(maxHeight: 200)
                            }
                        }
                        .padding(.horizontal, VSpacing.sm)
                    }
                }
                .padding(.bottom, VSpacing.sm)
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
                    // Trigger on-demand rehydration when expanding truncated content.
                    if isTruncated {
                        onRehydrate?()
                    }
                }
            }
        }
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(toolCall.isError
                    ? VColor.error.opacity(0.08)
                    : VColor.surfaceBorder.opacity(0.3))
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(toolCall.isError
                    ? VColor.error.opacity(0.3)
                    : VColor.surfaceBorder.opacity(0.5), lineWidth: 0.5)
        )
        .onChange(of: isExpanded) { _, newValue in
            // Populate the cache *before* the expanded body evaluates so that
            // `resolvedInputFull` returns the formatted input on the very first
            // render of the expanded section — avoiding a visible flash/pop-in
            // for lazy-loaded history tool calls where `.onAppear` fires too late.
            if newValue, cachedInputFull == nil {
                if let dict = toolCall.inputRawDict {
                    cachedInputFull = ToolCallData.formatAllToolInput(dict)
                } else if !toolCall.inputFull.isEmpty {
                    cachedInputFull = toolCall.inputFull
                }
            }
        }
        .onChange(of: toolCall.inputFull) {
            // Invalidate the cached formatted input so the next render picks up
            // the fresh (rehydrated) value instead of the stale truncated one.
            cachedInputFull = nil
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("ToolCallChip") {
    VStack(alignment: .leading, spacing: VSpacing.md) {
        ToolCallChip(toolCall: ToolCallData(
            toolName: "bash",
            inputSummary: "ls -la /Users/test/project",
            result: "total 42\ndrwxr-xr-x  10 user  staff  320 Jan  1 12:00 .\ndrwxr-xr-x   5 user  staff  160 Jan  1 11:00 ..",
            isComplete: true
        ))
        ToolCallChip(toolCall: ToolCallData(
            toolName: "file_read",
            inputSummary: "/src/main.swift",
            isComplete: false
        ))
        ToolCallChip(toolCall: ToolCallData(
            toolName: "file_edit",
            inputSummary: "/src/Config.swift",
            result: "File updated successfully.",
            isComplete: true
        ))
        ToolCallChip(toolCall: ToolCallData(
            toolName: "bash",
            inputSummary: "rm -rf /important",
            result: "Permission denied",
            isError: true,
            isComplete: true
        ))
    }
    .padding(VSpacing.xl)
    .background(VColor.background)
    .frame(width: 500)
}
#endif
