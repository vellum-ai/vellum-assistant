import VellumAssistantShared
import SwiftUI

struct DebugPanel: View {
    @ObservedObject var traceStore: TraceStore
    let activeSessionId: String?
    var onClose: () -> Void

    var body: some View {
        VSidePanel(title: "Debug", onClose: onClose, pinnedContent: {
            if let sessionId = activeSessionId {
                metricsStrip(sessionId: sessionId)
                Divider().background(VColor.surfaceBorder)
            }
        }) {
            if let sessionId = activeSessionId {
                let events = traceStore.eventsBySession[sessionId] ?? []
                if events.isEmpty {
                    VEmptyState(
                        title: "No trace events yet",
                        subtitle: "Events will appear as the session runs",
                        icon: "waveform.path"
                    )
                } else {
                    TraceTimelineView(traceStore: traceStore, sessionId: sessionId)
                }
            } else {
                VEmptyState(
                    title: "No session selected",
                    subtitle: "Start a conversation to see trace events",
                    icon: "ant"
                )
            }
        }
    }

    // MARK: - Metrics Strip

    @ViewBuilder
    private func metricsStrip(sessionId: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: VSpacing.lg) {
                metric(
                    icon: "arrow.right.circle",
                    label: "Requests",
                    value: "\(traceStore.requestCount(sessionId: sessionId))"
                )
                metric(
                    icon: "brain",
                    label: "LLM Calls",
                    value: "\(traceStore.llmCallCount(sessionId: sessionId))"
                )
                metric(
                    icon: "text.word.spacing",
                    label: "Tokens",
                    value: formatTokens(
                        input: traceStore.totalInputTokens(sessionId: sessionId),
                        output: traceStore.totalOutputTokens(sessionId: sessionId)
                    )
                )
                metric(
                    icon: "clock",
                    label: "Avg Latency",
                    value: formatLatency(traceStore.averageLlmLatencyMs(sessionId: sessionId))
                )

                let failures = traceStore.toolFailureCount(sessionId: sessionId)
                if failures > 0 {
                    metric(
                        icon: "exclamationmark.triangle.fill",
                        label: "Failures",
                        value: "\(failures)",
                        color: Rose._500
                    )
                }
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.vertical, VSpacing.md)
        }
    }

    @ViewBuilder
    private func metric(icon: String, label: String, value: String, color: Color = Emerald._400) -> some View {
        VStack(spacing: VSpacing.xxs) {
            HStack(spacing: VSpacing.xs) {
                Image(systemName: icon)
                    .font(.system(size: 10))
                    .foregroundColor(color)
                Text(value)
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.textPrimary)
            }
            Text(label)
                .font(VFont.small)
                .foregroundColor(VColor.textMuted)
        }
    }

    // MARK: - Formatters

    private func formatTokens(input: Int, output: Int) -> String {
        let total = input + output
        if total >= 1000 {
            return String(format: "%.1fk", Double(total) / 1000)
        }
        return "\(total)"
    }

    private func formatLatency(_ ms: Double) -> String {
        if ms <= 0 { return "--" }
        if ms >= 1000 {
            return String(format: "%.1fs", ms / 1000)
        }
        return String(format: "%.0fms", ms)
    }
}

#Preview {
    DebugPanel(traceStore: TraceStore(), activeSessionId: nil, onClose: {})
}
