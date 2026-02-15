import SwiftUI
import VellumAssistantShared

struct ActivityPanel: View {
    let toolCalls: [ToolCallData]
    let onClose: () -> Void

    var body: some View {
        VSidePanel(title: "Activity", onClose: onClose) {
            ScrollViewReader { proxy in
                ZStack(alignment: .leading) {
                    // Vertical timeline line aligned with center of status circles
                    Rectangle()
                        .fill(VColor.surfaceBorder)
                        .frame(width: 1)
                        .padding(.leading, 11) // center of 24pt circle

                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(toolCalls.enumerated()), id: \.element.id) { index, toolCall in
                            ActivityStepView(toolCall: toolCall)
                                .id(toolCall.id)
                                .padding(.vertical, VSpacing.sm)
                                .transition(.asymmetric(
                                    insertion: .move(edge: .top).combined(with: .opacity),
                                    removal: .opacity
                                ))

                            if index < toolCalls.count - 1 {
                                Divider()
                                    .background(VColor.surfaceBorder)
                                    .padding(.leading, 32)
                            }
                        }
                    }
                    .animation(VAnimation.standard, value: toolCalls.count)
                }
                .onChange(of: toolCalls.count) {
                    if let lastId = toolCalls.last?.id {
                        withAnimation(VAnimation.standard) {
                            proxy.scrollTo(lastId, anchor: .bottom)
                        }
                    }
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
                            Image(systemName: toolIcon)
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

                // Duration
                if toolCall.isComplete, let started = toolCall.startedAt, let completed = toolCall.completedAt {
                    let duration = completed.timeIntervalSince(started)
                    Text(formatDuration(duration))
                        .font(VFont.small)
                        .foregroundColor(VColor.textMuted)
                } else if !toolCall.isComplete, let started = toolCall.startedAt {
                    TimelineView(.animation(minimumInterval: 0.5)) { context in
                        let elapsed = context.date.timeIntervalSince(started)
                        Text(formatDuration(elapsed))
                            .font(VFont.small)
                            .foregroundColor(VColor.textMuted)
                    }
                }
            }

            // Input summary
            if !toolCall.inputSummary.isEmpty {
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: toolIcon)
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
                let accentColor = toolCall.isError ? VColor.error : VColor.accent

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text(result)
                        .font(VFont.monoSmall)
                        .foregroundColor(toolCall.isError ? VColor.error : VColor.textSecondary)
                        .lineLimit(isResultExpanded ? nil : 3)
                        .textSelection(.enabled)

                    // Show more/less button if text is long
                    if result.count > 80 || result.components(separatedBy: "\n").count > 3 {
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
                .background(Slate._900)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(accentColor)
                        .frame(width: 2)
                }
                .clipShape(RoundedRectangle(cornerRadius: VRadius.xs))
                .padding(.leading, 32)
                .transition(.opacity)
            }
        }
        .animation(VAnimation.fast, value: toolCall.isComplete)
    }

    private var toolIcon: String {
        let name = toolCall.toolName.lowercased()
        if name.contains("search") { return "magnifyingglass" }
        if name.contains("navigate") || name.contains("fetch") { return "globe" }
        if name.contains("screenshot") { return "camera.viewfinder" }
        if name.contains("click") { return "cursorarrow.click.2" }
        if name.contains("read") || name.contains("edit") || name.contains("write") { return "doc.text" }
        if name.contains("command") || name.contains("bash") || name.contains("shell") { return "terminal" }
        return "terminal"
    }

    private func formatDuration(_ seconds: TimeInterval) -> String {
        if seconds < 60 {
            return String(format: "%.1fs", seconds)
        }
        let mins = Int(seconds) / 60
        let secs = Int(seconds) % 60
        return "\(mins)m \(secs)s"
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
