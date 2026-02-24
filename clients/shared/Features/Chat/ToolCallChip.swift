import SwiftUI
#if os(macOS)
import AppKit
#endif

public struct ToolCallChip: View {
    public let toolCall: ToolCallData

    public init(toolCall: ToolCallData) {
        self.toolCall = toolCall
    }
    @State private var isExpanded = false

    private var hasExpandableContent: Bool {
        toolCall.result != nil || toolCall.cachedImage != nil
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
                    Image(systemName: toolCall.toolIcon)
                        .font(.system(size: 12))
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
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundColor(VColor.textMuted)
                    }
                }
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
            }
            .buttonStyle(.plain)

            // Expanded details
            if isExpanded, hasExpandableContent {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Divider()
                        .padding(.horizontal, VSpacing.sm)

                    // Technical details section
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Technical details")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                            .textCase(.uppercase)

                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text(toolCall.friendlyName)
                                .font(VFont.captionMedium)
                                .foregroundColor(VColor.textSecondary)
                            if !toolCall.inputFull.isEmpty {
                                Text(toolCall.inputFull)
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
                        let canOpenImage = !toolCall.inputSummary.isEmpty
                            && FileManager.default.fileExists(atPath: toolCall.inputSummary)
                        if canOpenImage {
                            Image(nsImage: cachedImage)
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(maxWidth: .infinity)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                                .padding(.horizontal, VSpacing.sm)
                                .onTapGesture(count: 2) {
                                    NSWorkspace.shared.open(URL(fileURLWithPath: toolCall.inputSummary))
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

                            ScrollView {
                                Text(result)
                                    .font(VFont.monoSmall)
                                    .foregroundColor(VColor.textSecondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .textSelection(.enabled)
                            }
                            .frame(maxHeight: 200)
                        }
                        .padding(.horizontal, VSpacing.sm)
                    }
                }
                .padding(.bottom, VSpacing.sm)
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
