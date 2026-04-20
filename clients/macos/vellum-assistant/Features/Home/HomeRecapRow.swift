import SwiftUI
import VellumAssistantShared

/// Compact row used in the time-bucketed Home feed.
///
/// Layout: a 26pt tinted icon circle + a single-line title + an optional
/// trailing Action button + a whole-row tap target. The row itself is
/// intentionally slim (icon pill drives the height) so a list of recaps
/// reads as a dense time-feed rather than a stack of cards.
///
/// The inner Action button is isolated from the outer row Button so its
/// tap never bubbles up to `onTap` — pressing "Resolve" (or whatever the
/// caller labels it) only fires `onAction`, not the row's `onTap`.
struct HomeRecapRow: View {
    let icon: VIcon
    /// Foreground color for the icon glyph. Callers pass semantic tokens
    /// (e.g. `VColor.systemNegativeStrong`, `VColor.systemPositiveStrong`).
    /// The plan referenced raw Danger/Forest 500-scale colors, which do
    /// not exist in this codebase — semantic tokens are the closest
    /// equivalent (see `ColorTokens.swift`).
    let iconForeground: Color
    /// Tinted background fill for the icon circle (e.g.
    /// `VColor.systemNegativeWeak`, `VColor.systemPositiveWeak`).
    let iconBackground: Color
    let title: String
    /// When `nil` (or paired with a nil `onAction`) the trailing button
    /// is not rendered and the row is still fully tappable.
    let actionLabel: String?
    let onAction: (() -> Void)?
    let onTap: () -> Void

    init(
        icon: VIcon,
        iconForeground: Color,
        iconBackground: Color,
        title: String,
        actionLabel: String? = nil,
        onAction: (() -> Void)? = nil,
        onTap: @escaping () -> Void
    ) {
        self.icon = icon
        self.iconForeground = iconForeground
        self.iconBackground = iconBackground
        self.title = title
        self.actionLabel = actionLabel
        self.onAction = onAction
        self.onTap = onTap
    }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: VSpacing.sm) {
                ZStack {
                    Circle().fill(iconBackground)
                    // 12pt glyph inside a 26pt circle ≈ 7pt padding, per mock.
                    VIconView(icon, size: 12)
                        .foregroundStyle(iconForeground)
                }
                .frame(width: 26, height: 26)

                Text(title)
                    // Mock uses #A9B2BB which is `contentSecondary` in the
                    // dark palette (see ColorTokens.swift).
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: VSpacing.sm)

                if let actionLabel, let onAction {
                    // Wrapping the inner button in its own view keeps its
                    // tap from bubbling to the outer row `Button` —
                    // SwiftUI resolves the innermost tappable first.
                    VButton(
                        label: actionLabel,
                        style: .outlined,
                        size: .pillRegular,
                        action: onAction
                    )
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                .fill(VColor.surfaceOverlay)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(title))
        .modifier(OptionalRecapActionAccessibility(
            actionLabel: actionLabel,
            onAction: onAction
        ))
    }
}

/// Adds an `.accessibilityAction(named:)` only when the row has a
/// non-nil action, so VoiceOver users can fire the inner Action button
/// without navigating to it.
private struct OptionalRecapActionAccessibility: ViewModifier {
    let actionLabel: String?
    let onAction: (() -> Void)?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let actionLabel, let onAction {
            content.accessibilityAction(named: Text(actionLabel), onAction)
        } else {
            content
        }
    }
}
