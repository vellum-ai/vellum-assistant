#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Full-screen debug panel for iOS, showing trace logs and conversation metrics.
///
/// Mirrors the macOS DebugPanel. Presented as a sheet from the chat view when
/// the developer toggle is enabled. Gated behind `UserDefaultsKeys.developerModeEnabled`.
struct DebugPanelView: View {
    @ObservedObject var traceStore: TraceStore
    let conversationId: String?
    var onClose: () -> Void

    @State private var loadingConversationId: String?
    @State private var hydrationTask: Task<Void, Never>?
    private let traceEventClient: any TraceEventClientProtocol = TraceEventClient()

    private var isLoadingHistory: Bool {
        loadingConversationId != nil && loadingConversationId == conversationId
    }

    private var hasEvents: Bool {
        guard let conversationId else { return false }
        return !(traceStore.eventsByConversation[conversationId] ?? []).isEmpty
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let conversationId {
                    metricsStrip(conversationId: conversationId)
                    Divider()

                    if hasEvents {
                        TraceTimelineIOSView(traceStore: traceStore, conversationId: conversationId)
                    } else if isLoadingHistory {
                        emptyState(
                            title: "Loading trace history...",
                            subtitle: "Fetching persisted events from the assistant",
                            icon: .audioWaveform
                        )
                    } else {
                        emptyState(
                            title: "No trace events yet",
                            subtitle: "Events will appear as the conversation runs",
                            icon: .audioWaveform
                        )
                    }
                } else {
                    emptyState(
                        title: "No conversation selected",
                        subtitle: "Start a conversation to see trace events",
                        icon: .bug
                    )
                }
            }
            .navigationTitle("Debug")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { onClose() }
                }
            }
        }
        .onAppear {
            traceStore.isObserved = true
            hydrateIfNeeded()
        }
        .onDisappear { traceStore.isObserved = false }
        .onChange(of: conversationId) { _, _ in
            hydrationTask?.cancel()
            hydrationTask = nil
            loadingConversationId = nil
            hydrateIfNeeded()
        }
    }

    // MARK: - History Hydration

    private func hydrateIfNeeded() {
        guard let conversationId else { return }
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
                    icon: .arrowRight,
                    label: "Requests",
                    value: "\(traceStore.requestCount(conversationId: conversationId))"
                )
                metric(
                    icon: .brain,
                    label: "LLM Calls",
                    value: "\(traceStore.llmCallCount(conversationId: conversationId))"
                )
                metric(
                    icon: .fileText,
                    label: "Tokens",
                    value: formatTokens(
                        input: traceStore.totalInputTokens(conversationId: conversationId),
                        output: traceStore.totalOutputTokens(conversationId: conversationId)
                    )
                )
                metric(
                    icon: .clock,
                    label: "Avg Latency",
                    value: formatLatency(traceStore.averageLlmLatencyMs(conversationId: conversationId))
                )

                let failures = traceStore.toolFailureCount(conversationId: conversationId)
                if failures > 0 {
                    metric(
                        icon: .triangleAlert,
                        label: "Failures",
                        value: "\(failures)",
                        color: VColor.systemNegativeStrong
                    )
                }
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.vertical, VSpacing.md)
        }
        .background(Color(.secondarySystemBackground))
    }

    @ViewBuilder
    private func metric(icon: VIcon, label: String, value: String, color: Color = VColor.systemPositiveStrong) -> some View {
        VStack(spacing: VSpacing.xxs) {
            HStack(spacing: VSpacing.xs) {
                VIconView(icon, size: 11)
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

    // MARK: - Empty State

    @ViewBuilder
    private func emptyState(title: String, subtitle: String, icon: VIcon) -> some View {
        VStack(spacing: VSpacing.md) {
            Spacer()
            VIconView(icon, size: 36)
                .foregroundColor(VColor.contentTertiary)
            Text(title)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
            Text(subtitle)
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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

// MARK: - Trace Timeline (iOS)

/// Scrollable trace event timeline for iOS, grouped by requestId.
///
/// Functionally equivalent to the macOS TraceTimelineView but uses iOS-native
/// scroll primitives and omits macOS-specific animation APIs.
struct TraceTimelineIOSView: View {
    @ObservedObject var traceStore: TraceStore
    let conversationId: String

    @State private var expandedEventIds: Set<String> = []
    @State private var isNearBottom = true
    @State private var disappearTask: Task<Void, Never>?

    private var groupedEvents: [(key: String, events: [TraceStore.StoredEvent])] {
        let byRequest = traceStore.eventsByRequest(conversationId: conversationId)
        return byRequest.map { (key: $0.key, events: $0.value) }
            .sorted { lhs, rhs in
                let lhsFirst = lhs.events.first?.sequence ?? 0
                let rhsFirst = rhs.events.first?.sequence ?? 0
                return lhsFirst < rhsFirst
            }
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: VSpacing.lg) {
                    ForEach(groupedEvents, id: \.key) { group in
                        requestGroup(group.key, events: group.events)
                    }

                    // Invisible anchor for auto-scroll and bottom detection.
                    Color.clear
                        .frame(height: 1)
                        .id("trace-bottom")
                        .onAppear {
                            disappearTask?.cancel()
                            disappearTask = nil
                            isNearBottom = true
                        }
                        .onDisappear {
                            disappearTask?.cancel()
                            disappearTask = Task { @MainActor in
                                try? await Task.sleep(for: .milliseconds(150))
                                guard !Task.isCancelled else { return }
                                isNearBottom = false
                            }
                        }
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.md)
            }
            .onChange(of: traceStore.latestEventIdByConversation[conversationId]) { _, _ in
                if isNearBottom {
                    withAnimation(VAnimation.fast) {
                        proxy.scrollTo("trace-bottom", anchor: .bottom)
                    }
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if !isNearBottom {
                    Button(action: {
                        withAnimation(VAnimation.fast) {
                            proxy.scrollTo("trace-bottom", anchor: .bottom)
                        }
                    }) {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.circleArrowDown, size: 11)
                            Text("Jump to bottom")
                                .font(VFont.small)
                        }
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .foregroundColor(VColor.systemNegativeHover)
                        .background(VColor.surfaceActive)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.sm)
                                .stroke(VColor.borderBase, lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                    .padding(VSpacing.sm)
                }
            }
        }
    }

    // MARK: - Request Group

    @ViewBuilder
    private func requestGroup(_ requestId: String, events: [TraceStore.StoredEvent]) -> some View {
        let groupStatus = traceStore.requestGroupStatus(conversationId: conversationId, requestId: requestId)

        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack(spacing: VSpacing.sm) {
                VIconView(groupStatusIcon(groupStatus), size: 11)
                    .foregroundColor(groupStatusColor(groupStatus))

                Text(requestId.isEmpty ? "System" : "Request \(requestId.prefix(8))")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.contentSecondary)

                if groupStatus == .cancelled {
                    Text("Cancelled")
                        .font(VFont.small)
                        .foregroundColor(VColor.systemNegativeHover)
                } else if groupStatus == .handedOff {
                    Text("Handed off")
                        .font(VFont.small)
                        .foregroundColor(VColor.systemPositiveWeak)
                } else if groupStatus == .error {
                    Text("Error")
                        .font(VFont.small)
                        .foregroundColor(VColor.systemNegativeStrong)
                }

                Rectangle()
                    .fill(VColor.borderBase)
                    .frame(height: 1)
            }

            ForEach(events) { event in
                eventRow(event)
            }
        }
    }

    private func groupStatusIcon(_ status: TraceStore.RequestGroupStatus) -> VIcon {
        switch status {
        case .active: return .arrowRight
        case .completed: return .circleCheck
        case .cancelled: return .circleX
        case .handedOff: return .refreshCw
        case .error: return .triangleAlert
        }
    }

    private func groupStatusColor(_ status: TraceStore.RequestGroupStatus) -> Color {
        switch status {
        case .active: return VColor.systemPositiveStrong
        case .completed: return VColor.systemPositiveStrong
        case .cancelled: return VColor.systemNegativeHover
        case .handedOff: return VColor.systemPositiveWeak
        case .error: return VColor.systemNegativeStrong
        }
    }

    // MARK: - Event Row

    @ViewBuilder
    private func eventRow(_ event: TraceStore.StoredEvent) -> some View {
        let isExpanded = expandedEventIds.contains(event.id)
        let hasAttributes = event.attributes != nil && !(event.attributes?.isEmpty ?? true)

        VStack(alignment: .leading, spacing: 0) {
            Button(action: {
                guard hasAttributes else { return }
                withAnimation(VAnimation.fast) {
                    if isExpanded {
                        expandedEventIds.remove(event.id)
                    } else {
                        expandedEventIds.insert(event.id)
                    }
                }
            }) {
                HStack(spacing: 0) {
                    traceRow(event: event)
                    if hasAttributes {
                        VIconView(isExpanded ? .chevronUp : .chevronDown, size: 10)
                            .foregroundColor(VColor.contentTertiary)
                            .frame(width: 18)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded, let attrs = event.attributes, !attrs.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    ForEach(attrs.keys.sorted(), id: \.self) { key in
                        HStack(spacing: VSpacing.sm) {
                            Text(key)
                                .font(VFont.small)
                                .foregroundColor(VColor.contentTertiary)
                            Text(stringValue(attrs[key]))
                                .font(VFont.small)
                                .foregroundColor(VColor.contentSecondary)
                                .lineLimit(3)
                        }
                    }
                }
                .padding(.leading, 26)
                .padding(.vertical, VSpacing.xs)
                .padding(.trailing, VSpacing.sm)
                .background(VColor.surfaceActive.opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            }
        }
    }

    // MARK: - Trace Row

    @ViewBuilder
    private func traceRow(event: TraceStore.StoredEvent) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            VIconView(iconName(for: event.kind), size: 12)
                .foregroundColor(statusColor(for: event.status))
                .frame(width: 20, alignment: .center)

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(event.summary)
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(2)

                Text(formattedTimestamp(event.timestampMs))
                    .font(VFont.small)
                    .foregroundColor(VColor.contentTertiary)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, VSpacing.xs)
    }

    private func iconName(for kind: String) -> VIcon {
        switch kind {
        case "request_received": return .circlePlay
        case "request_queued": return .inbox
        case "request_dequeued": return .inbox
        case "llm_call_started": return .brain
        case "llm_call_finished": return .brain
        case "assistant_message": return .messageCircle
        case "tool_started": return .wrench
        case "tool_permission_requested": return .shield
        case "tool_permission_decided": return .lockOpen
        case "tool_finished": return .wrench
        case "tool_failed": return .triangleAlert
        case "secret_detected": return .eye
        case "generation_handoff": return .refreshCw
        case "message_complete": return .circleCheck
        case "generation_cancelled": return .circleX
        case "request_error": return .circleAlert
        default: return .circle
        }
    }

    private func statusColor(for status: String?) -> Color {
        switch status {
        case "error": return VColor.systemNegativeStrong
        case "warning": return VColor.systemNegativeHover
        case "success": return VColor.systemPositiveStrong
        default: return VColor.contentTertiary
        }
    }

    private func formattedTimestamp(_ timestampMs: Double) -> String {
        let date = Date(timeIntervalSince1970: timestampMs / 1000)
        let formatter = DateFormatter()
        formatter.timeZone = .autoupdatingCurrent
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter.string(from: date)
    }

    private func stringValue(_ value: AnyCodable?) -> String {
        guard let value else { return "nil" }
        if let s = value.value as? String { return s }
        if let i = value.value as? Int { return "\(i)" }
        if let d = value.value as? Double { return String(format: "%.2f", d) }
        if let b = value.value as? Bool { return b ? "true" : "false" }
        return String(describing: value.value)
    }
}
#endif
