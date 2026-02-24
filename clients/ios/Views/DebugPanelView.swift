#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Full-screen debug panel for iOS, showing trace logs and session metrics.
///
/// Mirrors the macOS DebugPanel. Presented as a sheet from the chat view when
/// the developer toggle is enabled. Gated behind `UserDefaultsKeys.developerModeEnabled`.
struct DebugPanelView: View {
    @ObservedObject var traceStore: TraceStore
    let sessionId: String?
    var onClose: () -> Void

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let sessionId {
                    metricsStrip(sessionId: sessionId)
                    Divider()

                    let events = traceStore.eventsBySession[sessionId] ?? []
                    if events.isEmpty {
                        emptyState(
                            title: "No trace events yet",
                            subtitle: "Events will appear as the session runs",
                            icon: "waveform.path"
                        )
                    } else {
                        TraceTimelineIOSView(traceStore: traceStore, sessionId: sessionId)
                    }
                } else {
                    emptyState(
                        title: "No session selected",
                        subtitle: "Start a conversation to see trace events",
                        icon: "ant"
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
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.vertical, VSpacing.md)
        }
        .background(Color(.secondarySystemBackground))
    }

    @ViewBuilder
    private func metric(icon: String, label: String, value: String, color: Color = Emerald._400) -> some View {
        VStack(spacing: VSpacing.xxs) {
            HStack(spacing: VSpacing.xs) {
                Image(systemName: icon)
                    .font(.system(size: 11))
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

    // MARK: - Empty State

    @ViewBuilder
    private func emptyState(title: String, subtitle: String, icon: String) -> some View {
        VStack(spacing: VSpacing.md) {
            Spacer()
            Image(systemName: icon)
                .font(.system(size: 36, weight: .thin))
                .foregroundColor(VColor.textMuted)
            Text(title)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
            Text(subtitle)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
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
    let sessionId: String

    @State private var expandedEventIds: Set<String> = []
    @State private var isNearBottom = true
    @State private var disappearTask: Task<Void, Never>?

    private var groupedEvents: [(key: String, events: [TraceStore.StoredEvent])] {
        let byRequest = traceStore.eventsByRequest(sessionId: sessionId)
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
            .onChange(of: traceStore.latestEventIdBySession[sessionId]) { _, _ in
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
                            Image(systemName: "arrow.down.circle.fill")
                                .font(.system(size: 11))
                            Text("Jump to bottom")
                                .font(VFont.small)
                        }
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .foregroundColor(Amber._500)
                        .background(Moss._700)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.sm)
                                .stroke(VColor.surfaceBorder, lineWidth: 1)
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
        let groupStatus = traceStore.requestGroupStatus(sessionId: sessionId, requestId: requestId)

        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: groupStatusIcon(groupStatus))
                    .font(.system(size: 11))
                    .foregroundColor(groupStatusColor(groupStatus))

                Text(requestId.isEmpty ? "System" : "Request \(requestId.prefix(8))")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.textSecondary)

                if groupStatus == .cancelled {
                    Text("Cancelled")
                        .font(VFont.small)
                        .foregroundColor(Amber._500)
                } else if groupStatus == .handedOff {
                    Text("Handed off")
                        .font(VFont.small)
                        .foregroundColor(Forest._400)
                } else if groupStatus == .error {
                    Text("Error")
                        .font(VFont.small)
                        .foregroundColor(Danger._500)
                }

                Rectangle()
                    .fill(VColor.surfaceBorder)
                    .frame(height: 1)
            }

            ForEach(events) { event in
                eventRow(event)
            }
        }
    }

    private func groupStatusIcon(_ status: TraceStore.RequestGroupStatus) -> String {
        switch status {
        case .active: return "arrow.right.circle"
        case .completed: return "checkmark.circle.fill"
        case .cancelled: return "xmark.circle.fill"
        case .handedOff: return "arrow.right.arrow.left.circle.fill"
        case .error: return "exclamationmark.triangle.fill"
        }
    }

    private func groupStatusColor(_ status: TraceStore.RequestGroupStatus) -> Color {
        switch status {
        case .active: return Emerald._400
        case .completed: return Emerald._400
        case .cancelled: return Amber._500
        case .handedOff: return Forest._400
        case .error: return Danger._500
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
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 10))
                            .foregroundColor(VColor.textMuted)
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
                                .foregroundColor(VColor.textMuted)
                            Text(stringValue(attrs[key]))
                                .font(VFont.small)
                                .foregroundColor(VColor.textSecondary)
                                .lineLimit(3)
                        }
                    }
                }
                .padding(.leading, 26)
                .padding(.vertical, VSpacing.xs)
                .padding(.trailing, VSpacing.sm)
                .background(Moss._700.opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            }
        }
    }

    // MARK: - Trace Row

    @ViewBuilder
    private func traceRow(event: TraceStore.StoredEvent) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            Image(systemName: iconName(for: event.kind))
                .font(.system(size: 12))
                .foregroundColor(statusColor(for: event.status))
                .frame(width: 20, alignment: .center)

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(event.summary)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)

                Text(formattedTimestamp(event.timestampMs))
                    .font(VFont.small)
                    .foregroundColor(VColor.textMuted)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, VSpacing.xs)
    }

    private func iconName(for kind: String) -> String {
        switch kind {
        case "request_received": return "play.circle"
        case "request_queued": return "tray.and.arrow.down"
        case "request_dequeued": return "tray.and.arrow.up"
        case "llm_call_started": return "brain"
        case "llm_call_finished": return "brain.head.profile"
        case "assistant_message": return "text.bubble"
        case "tool_started": return "wrench.and.screwdriver"
        case "tool_permission_requested": return "lock.shield"
        case "tool_permission_decided": return "lock.open"
        case "tool_finished": return "wrench.and.screwdriver.fill"
        case "tool_failed": return "exclamationmark.triangle.fill"
        case "secret_detected": return "eye.trianglebadge.exclamationmark"
        case "generation_handoff": return "arrow.right.arrow.left.circle"
        case "message_complete": return "checkmark.circle"
        case "generation_cancelled": return "xmark.circle"
        case "request_error": return "exclamationmark.circle"
        default: return "circle.fill"
        }
    }

    private func statusColor(for status: String?) -> Color {
        switch status {
        case "error": return Danger._500
        case "warning": return Amber._500
        case "success": return Emerald._400
        default: return Moss._400
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

#Preview {
    DebugPanelView(traceStore: TraceStore(), sessionId: nil, onClose: {})
}
#endif
