import VellumAssistantShared
import SwiftUI

struct DebugPanel: View {
    @ObservedObject var traceStore: TraceStore
    @ObservedObject var daemonClient: DaemonClient
    let activeSessionId: String?
    var onClose: () -> Void

    var body: some View {
        VSidePanel(title: "Debug", onClose: onClose, pinnedContent: {
            if let conversationId = activeSessionId {
                metricsStrip(conversationId: conversationId)
                Divider().background(VColor.borderBase)

                // Render timeline in pinned area so it owns its own ScrollView
                // without nesting inside VSidePanel's scrollable content slot.
                let events = traceStore.eventsByConversation[conversationId] ?? []
                if !events.isEmpty {
                    TraceTimelineView(traceStore: traceStore, conversationId: conversationId)
                }
            }
        }) {
            if let conversationId = activeSessionId {
                let events = traceStore.eventsByConversation[conversationId] ?? []
                if events.isEmpty {
                    VEmptyState(
                        title: "No trace events yet",
                        subtitle: "Events will appear as the session runs",
                        icon: "waveform.path"
                    )
                }
            } else {
                VEmptyState(
                    title: "No session selected",
                    subtitle: "Start a conversation to see trace events",
                    icon: "ant"
                )
            }
        }
        .onAppear { traceStore.isObserved = true }
        .onDisappear { traceStore.isObserved = false }
    }

    // MARK: - Metrics Strip

    @ViewBuilder
    private func metricsStrip(conversationId: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: VSpacing.lg) {
                metric(
                    icon: "arrow.right.circle",
                    label: "Requests",
                    value: "\(traceStore.requestCount(conversationId: conversationId))"
                )
                metric(
                    icon: VIcon.brain.rawValue,
                    label: "LLM Calls",
                    value: "\(traceStore.llmCallCount(conversationId: conversationId))"
                )
                metric(
                    icon: "text.word.spacing",
                    label: "Tokens",
                    value: formatTokens(
                        input: traceStore.totalInputTokens(conversationId: conversationId),
                        output: traceStore.totalOutputTokens(conversationId: conversationId)
                    )
                )
                metric(
                    icon: "clock",
                    label: "Avg Latency",
                    value: formatLatency(traceStore.averageLlmLatencyMs(conversationId: conversationId))
                )

                let failures = traceStore.toolFailureCount(conversationId: conversationId)
                if failures > 0 {
                    metric(
                        icon: "exclamationmark.triangle.fill",
                        label: "Failures",
                        value: "\(failures)",
                        color: VColor.systemNegativeStrong
                    )
                }

                if let memory = daemonClient.latestMemoryStatus {
                    let memoryDegraded = memory.enabled && memory.degraded
                    metric(
                        icon: memoryDegraded ? "memorychip.fill" : "memorychip",
                        label: "Memory",
                        value: !memory.enabled ? "Disabled"
                            : memoryDegraded ? "Degraded"
                            : "Healthy",
                        color: !memory.enabled ? VColor.contentTertiary
                            : memoryDegraded ? VColor.systemNegativeHover
                            : VColor.systemPositiveStrong
                    )
                    if let provider = memory.provider {
                        metric(
                            icon: "cpu",
                            label: "Embed Provider",
                            value: memory.model.map { "\(provider)/\($0)" } ?? provider
                        )
                    }
                    if memoryDegraded, let reason = memory.reason {
                        metric(
                            icon: "exclamationmark.triangle",
                            label: "Degradation Reason",
                            value: reason,
                            color: VColor.systemNegativeHover
                        )
                    }
                }
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.vertical, VSpacing.md)
        }
    }

    @ViewBuilder
    private func metric(icon: String, label: String, value: String, color: Color = VColor.systemPositiveStrong) -> some View {
        VStack(spacing: VSpacing.xxs) {
            HStack(spacing: VSpacing.xs) {
                VIconView(SFSymbolMapping.icon(forSFSymbol: icon, fallback: .puzzle), size: 10)
                    .foregroundColor(color)
                Text(value)
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.contentDefault)
            }
            Text(label)
                .font(VFont.small)
                .foregroundColor(VColor.contentTertiary)
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
    DebugPanel(traceStore: TraceStore(), daemonClient: DaemonClient(), activeSessionId: nil, onClose: {})
}
