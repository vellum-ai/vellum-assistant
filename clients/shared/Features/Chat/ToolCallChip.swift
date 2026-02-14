import SwiftUI

public struct ToolCallChip: View {
    public let toolCall: ToolCallData

    public init(toolCall: ToolCallData) {
        self.toolCall = toolCall
    }
    @State private var isExpanded = false

    private var toolDisplayName: String {
        toolCall.toolName
    }

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
                    // Terminal icon
                    Image(systemName: "terminal")
                        .font(.system(size: 12))
                        .foregroundColor(toolCall.isError ? VColor.error : VColor.textSecondary)

                    // Tool name
                    Text(toolDisplayName)
                        .font(VFont.captionMedium)
                        .foregroundColor(toolCall.isError ? VColor.error : VColor.textPrimary)

                    // Input summary (truncated)
                    if !toolCall.inputSummary.isEmpty {
                        Text(toolCall.inputSummary)
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }

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

            // Expanded result
            if isExpanded, hasExpandableContent {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    // Image preview (for browser_screenshot etc.)
                    if let cachedImage = toolCall.cachedImage {
                        #if os(macOS)
                        Image(nsImage: cachedImage)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxWidth: .infinity)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        #elseif os(iOS)
                        Image(uiImage: cachedImage)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxWidth: .infinity)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        #endif
                    }

                    // Text result
                    if let result = toolCall.result {
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
            toolName: "Run Command",
            inputSummary: "ls -la /Users/test/project",
            result: "total 42\ndrwxr-xr-x  10 user  staff  320 Jan  1 12:00 .\ndrwxr-xr-x   5 user  staff  160 Jan  1 11:00 ..",
            isComplete: true
        ))
        ToolCallChip(toolCall: ToolCallData(
            toolName: "Read File",
            inputSummary: "/src/main.swift",
            isComplete: false
        ))
        ToolCallChip(toolCall: ToolCallData(
            toolName: "Run Command",
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
