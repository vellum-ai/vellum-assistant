import SwiftUI
import VellumAssistantShared

/// Horizontal filter bar rendered between the suggestion pills and the
/// time-grouped Home feed.
///
/// Layout: "Filter:" caption + a single icon-circle chip + an animated
/// label that appears when the chip is selected. The chip is single-select:
/// tapping it makes it the active filter; tapping the active chip again
/// clears the filter. A nil ``selected`` means "show everything".
///
/// Pre-v2 the bar exposed four chips (one per `FeedItemType` case). With
/// the schema collapse to a single `notification` type the bar reduces to
/// one chip; PR 17 is expected to remove the bar entirely once the
/// downstream UI no longer needs a filter affordance.
struct HomeFeedFilterBar: View {
    let selected: FeedItemType?
    let onToggle: (FeedItemType) -> Void

    /// Kept as a static list so the iteration order is deterministic.
    private static let chipOrder: [FeedItemType] = [.notification]

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
/// carry semantic color; changing their opacity would blur the
/// signal. A neutral outline reads as "selected" without competing
/// with the chip tint.
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

    /// Pre-v2 each type had its own glyph (heart / arrowLeft / bell /
    /// calendar). With only `.notification` left we settle on the bell
    /// glyph as the generic "you have a notification" affordance.
    private var icon: VIcon {
        switch type {
        case .notification: return .bell
        }
    }

    /// Glyph color. Single-tint now that the type discriminator is gone;
    /// see `ColorTokens.swift` for the underlying tokens.
    private var foreground: Color {
        switch type {
        case .notification: return VColor.feedDigestStrong
        }
    }

    /// Tinted circle fill paired with `foreground` above.
    private var background: Color {
        switch type {
        case .notification: return VColor.feedDigestWeak
        }
    }

    /// Human-readable label for VoiceOver and the visible selected-state
    /// caption in the filter bar.
    static func label(for type: FeedItemType) -> String {
        switch type {
        case .notification: return "Notifications"
        }
    }

    private var accessibilityName: String {
        Self.label(for: type)
    }
}
