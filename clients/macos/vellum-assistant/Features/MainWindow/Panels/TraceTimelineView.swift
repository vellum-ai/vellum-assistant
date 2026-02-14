import SwiftUI
import VellumAssistantShared

/// Scrollable trace event timeline grouped by requestId, with auto-scroll behavior
/// that pauses when the user manually scrolls up.
struct TraceTimelineView: View {
    @ObservedObject var traceStore: TraceStore
    let sessionId: String

    @State private var autoScrollPaused = false
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

                    // Invisible anchor for auto-scroll
                    Color.clear
                        .frame(height: 1)
                        .id("trace-bottom")
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.md)
            }
            .onChange(of: traceStore.eventsBySession[sessionId]?.count) {
                if !autoScrollPaused {
                    withAnimation(VAnimation.fast) {
                        proxy.scrollTo("trace-bottom", anchor: .bottom)
                    }
                }
            }
        }
        .overlay(alignment: .bottomTrailing) {
            autoScrollToggle
        }
    }

    @ViewBuilder
    private var autoScrollToggle: some View {
        Button(action: { autoScrollPaused.toggle() }) {
            HStack(spacing: VSpacing.xs) {
                Image(systemName: autoScrollPaused ? "play.fill" : "pause.fill")
                    .font(.system(size: 9))
                Text(autoScrollPaused ? "Resume" : "Auto-scroll")
                    .font(VFont.small)
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .foregroundColor(autoScrollPaused ? Amber._500 : VColor.textMuted)
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

    // MARK: - Request Group

    @ViewBuilder
    private func requestGroup(_ requestId: String, events: [TraceStore.StoredEvent]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "arrow.right.circle")
                    .font(.system(size: 10))
                    .foregroundColor(Emerald._400)

                Text(requestId.isEmpty ? "System" : "Request \(requestId.prefix(8))")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.textSecondary)

                Rectangle()
                    .fill(VColor.surfaceBorder)
                    .frame(height: 1)
            }

            ForEach(events) { event in
                eventRow(event)
            }
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
