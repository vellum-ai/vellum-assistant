import VellumAssistantShared
import SwiftUI

struct DebugPanel: View {
    @ObservedObject var traceStore: TraceStore
    @ObservedObject var daemonClient: DaemonClient
    let activeSessionId: String?
    var onClose: () -> Void

    var body: some View {
        VSidePanel(title: "Debug", onClose: onClose, pinnedContent: {
            if let sessionId = activeSessionId {
                metricsStrip(sessionId: sessionId)
                Divider().background(VColor.surfaceBorder)

                // Render timeline in pinned area so it owns its own ScrollView
                // without nesting inside VSidePanel's scrollable content slot.
                let events = traceStore.eventsBySession[sessionId] ?? []
                if !events.isEmpty {
                    TraceTimelineView(traceStore: traceStore, sessionId: sessionId)
                }
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
                        color: Danger._500
                    )
                }

                if let memory = daemonClient.latestMemoryStatus {
                    metric(
                        icon: "memorychip",
                        label: "Pending Conflicts",
                        value: formatWhole(memory.conflictsPending)
                    )
                    metric(
                        icon: "checkmark.seal",
                        label: "Resolved Conflicts",
                        value: formatWhole(memory.conflictsResolved)
                    )
                    metric(
                        icon: "clock.arrow.circlepath",
                        label: "Oldest Pending",
                        value: formatDurationMs(memory.oldestPendingConflictAgeMs)
                    )
                    metric(
                        icon: "tray.full",
                        label: "Cleanup Backlog",
                        value: "R \(formatWhole(memory.cleanupResolvedJobsPending)) / S \(formatWhole(memory.cleanupSupersededJobsPending))"
                    )
                    metric(
                        icon: "sparkles",
                        label: "Cleanup 24h",
                        value: "R \(formatWhole(memory.cleanupResolvedJobsCompleted24h)) / S \(formatWhole(memory.cleanupSupersededJobsCompleted24h))"
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

    private func formatWhole(_ value: Int) -> String {
        "\(value)"
    }

    private func formatWhole(_ value: Double) -> String {
        "\(Int(value.rounded()))"
    }

    private func formatDurationMs(_ value: Int?) -> String {
        guard let value else { return "n/a" }
        return formatDurationMs(Double(value))
    }

    private func formatDurationMs(_ value: Double?) -> String {
        guard let value else { return "n/a" }
        if value < 60_000 {
            return String(format: "%.0fs", value / 1000)
        }
        if value < 3_600_000 {
            return String(format: "%.0fm", value / 60_000)
        }
        return String(format: "%.1fh", value / 3_600_000)
    }
}

#Preview {
    DebugPanel(traceStore: TraceStore(), daemonClient: DaemonClient(), activeSessionId: nil, onClose: {})
}
