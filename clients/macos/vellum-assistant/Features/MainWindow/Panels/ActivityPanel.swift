import SwiftUI
import VellumAssistantShared

struct ActivityPanel: View {
    let toolCalls: [ToolCallData]
    let onClose: () -> Void

    var body: some View {
        VSidePanel(title: "Activity", onClose: onClose) {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                ForEach(toolCalls) { toolCall in
                    ActivityStepView(toolCall: toolCall)
                }
            }
        }
    }
}

struct ActivityStepView: View {
    let toolCall: ToolCallData
    @State private var isResultExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Step header with icon
            HStack(spacing: VSpacing.sm) {
                // Status icon
                ZStack {
                    Circle()
                        .fill(statusColor.opacity(0.15))
                        .frame(width: 24, height: 24)

                    if toolCall.isComplete {
                        if toolCall.isError {
                            Image(systemName: "xmark")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundColor(VColor.error)
                        } else {
                            Image(systemName: "checkmark")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundColor(VColor.accent)
                        }
                    } else {
                        ProgressView()
                            .scaleEffect(0.5)
                            .tint(VColor.accent)
                    }
                }

                // Step name
                Text(toolCall.toolName)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)

                Spacer()
            }

            // Input summary
            if !toolCall.inputSummary.isEmpty {
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "terminal")
                        .font(.system(size: 11))
                        .foregroundColor(VColor.textMuted)

                    Text(toolCall.inputSummary)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .lineLimit(2)
                }
                .padding(.leading, 32) // Align with text after icon
            }

            // Screenshot
            if let cachedImage = toolCall.cachedImage {
                Image(nsImage: cachedImage)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    .padding(.leading, 32)
            }

            // Result
            if let result = toolCall.result, !result.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text(result)
                        .font(VFont.monoSmall)
                        .foregroundColor(toolCall.isError ? VColor.error : VColor.textSecondary)
                        .lineLimit(isResultExpanded ? nil : 6)
                        .textSelection(.enabled)

                    // Show more/less button if text is long
                    if result.count > 200 || result.split(separator: "\n").count > 6 {
                        Button(action: {
                            withAnimation(VAnimation.fast) {
                                isResultExpanded.toggle()
                            }
                        }) {
                            HStack(spacing: VSpacing.xxs) {
                                Text(isResultExpanded ? "Show less" : "Show more")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.accent)
                                Image(systemName: isResultExpanded ? "chevron.up" : "chevron.down")
                                    .font(.system(size: 9, weight: .semibold))
                                    .foregroundColor(VColor.accent)
                            }
                        }
                        .buttonStyle(.plain)
                        .padding(.top, VSpacing.xxs)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .fill(VColor.surface)
                )
                .padding(.leading, 32)
            }
        }
        .padding(VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(toolCall.isError ? VColor.error.opacity(0.05) : VColor.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
    }

    private var statusColor: Color {
        if toolCall.isError {
            return VColor.error
        } else if toolCall.isComplete {
            return VColor.accent
        } else {
            return VColor.accent
        }
    }
}

// MARK: - Preview

#if DEBUG
struct ActivityPanel_Previews: PreviewProvider {
    static var previews: some View {
        ActivityPanel(
            toolCalls: [
                ToolCallData(
                    toolName: "Web Search",
                    inputSummary: "flights from New York to London next week",
                    result: "Found 5 search results",
                    isComplete: true
                ),
                ToolCallData(
                    toolName: "Browser Navigate",
                    inputSummary: "https://www.google.com/travel/flights",
                    result: "Navigated successfully",
                    isComplete: true
                ),
                ToolCallData(
                    toolName: "Browser Screenshot",
                    inputSummary: "",
                    isComplete: true
                ),
                ToolCallData(
                    toolName: "Browser Click",
                    inputSummary: "[aria-label=\"Departure\"]",
                    isComplete: false
                )
            ],
            onClose: {}
        )
        .frame(height: 600)
    }
}
#endif
