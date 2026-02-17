import SwiftUI
import VellumAssistantShared

struct ActivityPanel: View {
    @ObservedObject var viewModel: ChatViewModel
    let messageId: UUID
    let onClose: () -> Void

    private var toolCalls: [ToolCallData] {
        viewModel.messages.first(where: { $0.id == messageId })?.toolCalls ?? []
    }

    var body: some View {
        VSidePanel(title: "Activity", onClose: onClose) {
            ScrollViewReader { proxy in
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(toolCalls, id: \.id) { toolCall in
                        ActivityStepView(toolCall: toolCall)
                            .id(toolCall.id)
                            .transition(.asymmetric(
                                insertion: .move(edge: .top).combined(with: .opacity),
                                removal: .opacity
                            ))
                    }
                }
                .animation(VAnimation.standard, value: toolCalls.count)
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
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Collapsed row — always visible, clickable to expand
            Button(action: {
                guard hasExpandableContent else { return }
                withAnimation(VAnimation.fast) {
                    isExpanded.toggle()
                }
            }) {
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

                    // Tool name + input summary
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text(toolCall.toolName)
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.textPrimary)

                        if !toolCall.inputSummary.isEmpty {
                            Text(toolCall.inputSummary)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }

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

                    // Chevron
                    if hasExpandableContent {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(VColor.textMuted)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                }
                .padding(.vertical, VSpacing.sm)
                .padding(.horizontal, VSpacing.md)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // Expanded details
            if isExpanded {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    // Screenshot
                    if let cachedImage = toolCall.cachedImage {
                        Image(nsImage: cachedImage)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxWidth: .infinity)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    }

                    // Result
                    if let result = toolCall.result, !result.isEmpty {
                        Text(result)
                            .font(VFont.monoSmall)
                            .foregroundColor(toolCall.isError ? VColor.error : VColor.textSecondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(VSpacing.sm)
                            .background(VColor.backgroundSubtle.opacity(0.5))
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    }
                }
                .padding(.horizontal, VSpacing.md)
                .padding(.leading, 24 + VSpacing.sm) // align with text after icon
                .padding(.bottom, VSpacing.sm)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(VAnimation.fast, value: isExpanded)
        .animation(VAnimation.fast, value: toolCall.isComplete)
    }

    private var hasExpandableContent: Bool {
        (toolCall.result != nil && !(toolCall.result?.isEmpty ?? true)) || toolCall.cachedImage != nil
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
        } else {
            return VColor.accent
        }
    }
}

// MARK: - Preview

#if DEBUG
struct ActivityPanel_Previews: PreviewProvider {
    static var previews: some View {
        let dc = DaemonClient()
        let viewModel = ChatViewModel(daemonClient: dc)
        let messageId = UUID()

        viewModel.messages = [
            ChatMessage(
                id: messageId,
                role: .assistant,
                text: "Finding flights for you",
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
                        result: "Requested URL: https://www.google.com/travel/flights\nFinal URL: https://www.google.com/travel/flights\nStatus: 200\nTitle: Google Flights",
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
                ]
            )
        ]

        return ActivityPanel(
            viewModel: viewModel,
            messageId: messageId,
            onClose: {}
        )
        .frame(height: 600)
    }
}
#endif
