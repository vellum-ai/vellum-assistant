import SwiftUI
import VellumAssistantShared

/// Horizontal filter bar rendered between the suggestion pills and the
/// time-grouped Home feed.
///
/// Layout: "Filter:" caption + four icon-circle chips + an animated
/// label that appears when a chip is selected. Chips are single-select:
/// tapping a chip makes it the active filter; tapping the active chip
/// again clears the filter. A nil ``selected`` means "show everything".
struct HomeFeedFilterBar: View {
    let selected: FeedItemType?
    let onToggle: (FeedItemType) -> Void

    /// Kept as a static list so the iteration order is deterministic.
    private static let chipOrder: [FeedItemType] = [.nudge, .action, .digest, .thread]

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.sm) {
            Text("Filter:")
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentSecondary)

            ForEach(Self.chipOrder, id: \.self) { type in
                HomeFeedFilterChip(
                    type: type,
                    isSelected: selected == type,
                    onToggle: { onToggle(type) }
                )
            }

            if let selected {
                Text(HomeFeedFilterChip.label(for: selected))
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentSecondary)
                    .transition(.opacity)
            }
        }
        .animation(VAnimation.standard, value: selected)
    }
}

/// Single 26pt icon-circle filter chip. Private to this file — the
/// bar is the only legitimate caller.
///
/// Selected-state treatment: a thin 1.5pt `strokeBorder` in
/// `VColor.contentDefault` wrapped around the existing chip fill.
/// Picked over "boost saturation" because the chip fills already
/// carry semantic color (red/blue/green/amber); changing their
/// opacity would blur the type signal. A neutral outline reads as
/// "selected" without competing with the type tint.
private struct HomeFeedFilterChip: View {
    let type: FeedItemType
    let isSelected: Bool
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            ZStack {
                Circle().fill(background)
                // 12pt glyph inside a 26pt circle ≈ 7pt padding, same
                // ratio the HomeRecapRow icon uses.
                VIconView(icon, size: 12)
                    .foregroundStyle(foreground)
            }
            .frame(width: 26, height: 26)
            .overlay {
                if isSelected {
                    Circle()
                        .strokeBorder(VColor.contentDefault, lineWidth: 1.5)
                }
            }
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .accessibilityLabel(Text("\(accessibilityName) filter"))
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityValue(Text(isSelected ? "active" : "inactive"))
    }

    // MARK: - Per-type styling

    private var icon: VIcon {
        switch type {
        case .nudge:   return .heart
        case .action:  return .arrowLeft
        case .digest:  return .bell
        case .thread:  return .calendar
        }
    }

    /// Glyph color. `.action` uses the info/blue pair; the other three
    /// use the dedicated feed-type pairs (pink / teal / amber per Figma).
    /// See `ColorTokens.swift`.
    private var foreground: Color {
        switch type {
        case .nudge:   return VColor.feedNudgeStrong
        case .action:  return VColor.systemInfoStrong
        case .digest:  return VColor.feedDigestStrong
        case .thread:  return VColor.feedThreadStrong
        }
    }

    /// Tinted circle fill. Paired with `foreground` above to match
    /// the Figma chip-by-chip color mapping.
    private var background: Color {
        switch type {
        case .nudge:   return VColor.feedNudgeWeak
        case .action:  return VColor.systemInfoWeak
        case .digest:  return VColor.feedDigestWeak
        case .thread:  return VColor.feedThreadWeak
        }
    }

    /// Human-readable label for VoiceOver and the visible selected-state
    /// caption in the filter bar.
    static func label(for type: FeedItemType) -> String {
        switch type {
        case .nudge:   return "Heartbeat"
        case .action:  return "Needs attention"
        case .digest:  return "Just so you know"
        case .thread:  return "Scheduled"
        }
    }

    private var accessibilityName: String {
        Self.label(for: type)
    }
}
