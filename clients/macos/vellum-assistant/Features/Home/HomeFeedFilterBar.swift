import SwiftUI
import VellumAssistantShared

/// Horizontal filter bar rendered between the suggestion pills and the
/// time-grouped Home feed. Figma: `3596:79557` (New App).
///
/// Layout: a 12pt "Filter:" caption + a row of four 26pt icon-circle
/// chips — Heartbeat (`.nudge`), Input (`.action`), Notification
/// (`.digest`), and Schedule (`.thread`). Chips are single-select:
/// tapping a chip makes it the active filter; tapping the active chip
/// again clears the filter. A nil ``selected`` means "show everything" —
/// the parent view is responsible for applying the filter to its feed.
///
/// The chip shape + tint mapping is intentionally aligned with
/// ``HomeRecapRow``'s leading icon, so the filter chips and the row
/// icons read as a single visual language.
struct HomeFeedFilterBar: View {
    let selected: FeedItemType?
    let onToggle: (FeedItemType) -> Void

    /// Order matches the Figma mock (Heartbeat, Input, Notification,
    /// Schedule). Kept as a static list so the iteration order is
    /// deterministic across renders.
    private static let chipOrder: [FeedItemType] = [.nudge, .action, .digest, .thread]

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.sm) {
            Text("Filter:")
                // Figma label: 12pt Inter Semibold, #5A6672 →
                // `bodySmallEmphasised` (DM Sans 500-weight 12pt, our
                // closest equivalent) + `contentSecondary` token.
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentSecondary)

            ForEach(Self.chipOrder, id: \.self) { type in
                HomeFeedFilterChip(
                    type: type,
                    isSelected: selected == type,
                    onToggle: { onToggle(type) }
                )
            }
        }
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

    /// Human-readable name used in the VoiceOver label.
    private var accessibilityName: String {
        switch type {
        case .nudge:   return "Heartbeat"
        case .action:  return "Input"
        case .digest:  return "Notification"
        case .thread:  return "Schedule"
        }
    }
}
