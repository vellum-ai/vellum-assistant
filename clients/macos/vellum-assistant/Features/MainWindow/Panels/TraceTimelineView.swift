import SwiftUI
import VellumAssistantShared

/// Scrollable trace event timeline grouped by requestId, with auto-scroll behavior
/// that pauses when the user manually scrolls up.
struct TraceTimelineView: View {
    @ObservedObject var traceStore: TraceStore
    let conversationId: String

    /// Tracks whether auto-scroll is active. Uses a debounced approach to avoid
    /// a race condition where new content pushes the bottom anchor out of the
    /// viewport (firing onDisappear) before onChange can auto-scroll.
    @State private var isNearBottom = true
    /// Pending task that will set isNearBottom to false after a short delay.
    /// Cancelled if onAppear fires again (e.g. after auto-scroll completes).
    @State private var disappearTask: Task<Void, Never>?
    @State private var expandedEventIds: Set<String> = []

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
                    // Uses debounced onDisappear to avoid a race where new content
                    // pushes the anchor out of view before onChange can auto-scroll.
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
            .onChange(of: traceStore.latestEventIdBySession[conversationId]) {
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
                            VIconView(.circleArrowDown, size: 9)
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
                VIconView(groupStatusIcon(groupStatus), size: 10)
                    .foregroundColor(groupStatusColor(groupStatus))

                Text(requestId.isEmpty ? "System" : "Request \(requestId.prefix(8))")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.contentSecondary)
                    .textSelection(.enabled)

                if groupStatus == .cancelled {
                    Text("Cancelled")
                        .font(VFont.small)
                        .foregroundColor(VColor.systemNegativeHover)
                        .textSelection(.enabled)
                } else if groupStatus == .handedOff {
                    Text("Handed off")
                        .font(VFont.small)
                        .foregroundColor(VColor.systemPositiveWeak)
                        .textSelection(.enabled)
                } else if groupStatus == .error {
                    Text("Error")
                        .font(VFont.small)
                        .foregroundColor(VColor.systemNegativeStrong)
                        .textSelection(.enabled)
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

    // MARK: - Event Row (with expandable attributes)

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
                    TraceRowView(event: event)

                    if hasAttributes {
                        VIconView(isExpanded ? .chevronUp : .chevronDown, size: 9)
                            .foregroundColor(VColor.contentTertiary)
                            .frame(width: 16)
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
                                .textSelection(.enabled)
                            Text(stringValue(attrs[key]))
                                .font(VFont.small)
                                .foregroundColor(VColor.contentSecondary)
                                .lineLimit(3)
                                .textSelection(.enabled)
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

    private func stringValue(_ value: AnyCodable?) -> String {
        guard let value else { return "nil" }
        if let s = value.value as? String { return s }
        if let i = value.value as? Int { return "\(i)" }
        if let d = value.value as? Double { return String(format: "%.2f", d) }
        if let b = value.value as? Bool { return b ? "true" : "false" }
        return String(describing: value.value)
    }
}
