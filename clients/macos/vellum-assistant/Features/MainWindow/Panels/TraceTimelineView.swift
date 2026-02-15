import SwiftUI
import VellumAssistantShared

/// Scrollable trace event timeline grouped by requestId, with auto-scroll behavior
/// that pauses when the user manually scrolls up.
struct TraceTimelineView: View {
    @ObservedObject var traceStore: TraceStore
    let sessionId: String

    /// Tracks whether the bottom anchor is visible — when true, new events
    /// auto-scroll to the bottom. When the user scrolls up and the anchor
    /// leaves the viewport, auto-scroll pauses until they return to the bottom.
    @State private var isNearBottom = true
    @State private var expandedEventIds: Set<String> = []

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

                    // Invisible anchor for auto-scroll and bottom detection
                    Color.clear
                        .frame(height: 1)
                        .id("trace-bottom")
                        .onAppear { isNearBottom = true }
                        .onDisappear { isNearBottom = false }
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.md)
            }
            .onChange(of: traceStore.latestEventIdBySession[sessionId]) {
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
                                .font(.system(size: 9))
                            Text("Jump to bottom")
                                .font(VFont.small)
                        }
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .foregroundColor(Amber._500)
                        .background(Slate._800)
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
                    .font(.system(size: 10))
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
                        .foregroundColor(Indigo._400)
                } else if groupStatus == .error {
                    Text("Error")
                        .font(VFont.small)
                        .foregroundColor(Rose._500)
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
        case .handedOff: return Indigo._400
        case .error: return Rose._500
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
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9))
                            .foregroundColor(VColor.textMuted)
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
                .background(Slate._800.opacity(0.5))
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
