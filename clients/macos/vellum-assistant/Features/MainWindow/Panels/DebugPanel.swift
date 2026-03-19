import VellumAssistantShared
import SwiftUI

struct DebugPanel: View {
    @ObservedObject var traceStore: TraceStore
    @ObservedObject var daemonClient: DaemonClient
    let activeSessionId: String?
    var onClose: () -> Void

    @State private var loadingConversationId: String?
    @State private var hydrationTask: Task<Void, Never>?
    private let traceEventClient: any TraceEventClientProtocol = TraceEventClient()

    private var isLoadingHistory: Bool {
        loadingConversationId != nil && loadingConversationId == activeSessionId
    }

    private var hasEvents: Bool {
        guard let conversationId = activeSessionId else { return false }
        return !(traceStore.eventsByConversation[conversationId] ?? []).isEmpty
    }

    var body: some View {
        VSidePanel(title: "Logs", onClose: onClose, pinnedContent: {
            if let conversationId = activeSessionId {
                metricsStrip(conversationId: conversationId)
                Divider().background(VColor.borderBase)

                // Render timeline in pinned area so it owns its own ScrollView
                // without nesting inside VSidePanel's scrollable content slot.
                if hasEvents {
                    TraceTimelineView(traceStore: traceStore, conversationId: conversationId)
                }
            }

            // Empty states live in the pinned (non-scrollable) area so they
            // stay centered and the panel doesn't scroll when there's nothing.
            if !hasEvents {
                Spacer()
                if activeSessionId != nil {
                    if isLoadingHistory {
                        VEmptyState(
                            title: "Loading trace history...",
                            subtitle: "Fetching persisted events from the assistant",
                            icon: "waveform.path"
                        )
                    } else {
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
                Spacer()
            }
        }) {
            // Content slot intentionally empty when no events — the empty
            // state is rendered in pinnedContent above to avoid scrolling.
            EmptyView()
        }
        .onAppear {
            traceStore.isObserved = true
            hydrateIfNeeded()
        }
        .onDisappear { traceStore.isObserved = false }
        .onChange(of: activeSessionId) { _, _ in
            hydrationTask?.cancel()
            hydrationTask = nil
            loadingConversationId = nil
            hydrateIfNeeded()
        }
    }

    // MARK: - History Hydration

    private func hydrateIfNeeded() {
        guard let conversationId = activeSessionId else { return }
        guard loadingConversationId != conversationId else { return }
        loadingConversationId = conversationId
        hydrationTask = Task {
            defer {
                if !Task.isCancelled {
                    loadingConversationId = nil
                    hydrationTask = nil
                }
            }
            do {
                let events = try await traceEventClient.fetchHistory(conversationId: conversationId)
                guard !Task.isCancelled else { return }
                traceStore.loadHistory(events)
            } catch {
                // Fetch failed — fall back to the existing "No trace events yet" empty state.
            }
        }
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
                            : memoryDegraded ? VColor.systemMidStrong
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
                            color: VColor.systemMidStrong
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
