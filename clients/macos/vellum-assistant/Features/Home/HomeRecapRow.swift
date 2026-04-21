import SwiftUI
import VellumAssistantShared

/// Compact row used in the time-bucketed Home feed.
///
/// Layout: a 26pt tinted icon circle + a single-line title + a trailing
/// hover-only Dismiss affordance + a whole-row tap target. The row
/// itself is intentionally slim (icon pill drives the height) so a list
/// of recaps reads as a dense time-feed rather than a stack of cards.
///
/// The Dismiss affordance appears only while the pointer is over the
/// row (Figma `3596:79329` — hover state). Its tap is isolated from the
/// outer row Button so clicking "Dismiss" never fires the row's
/// `onTap` — SwiftUI resolves the innermost tappable first.
struct HomeRecapRow: View {
    let icon: VIcon
    /// Foreground color for the icon glyph. Callers pass semantic tokens
    /// (e.g. `VColor.systemNegativeStrong`, `VColor.systemInfoStrong`).
    let iconForeground: Color
    /// Tinted background fill for the icon circle (e.g.
    /// `VColor.systemNegativeWeak`, `VColor.systemInfoWeak`).
    let iconBackground: Color
    let title: String
    let onDismiss: () -> Void
    let onTap: () -> Void

    @State private var isHovering: Bool = false

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

                if isHovering {
                    // Wrapping the dismiss in its own Button keeps the tap
                    // from bubbling to the outer row Button — SwiftUI
                    // resolves the innermost tappable first.
                    Button(action: onDismiss) {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.x, size: 7)
                                .foregroundStyle(VColor.contentDisabled)
                            Text("Dismiss")
                                .font(VFont.bodySmallDefault)
                                .foregroundStyle(VColor.contentDisabled)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                    .accessibilityLabel(Text("Dismiss"))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.md, bottom: VSpacing.sm, trailing: VSpacing.md))
        .background(
            RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                .fill(isHovering ? VColor.surfaceLift : VColor.surfaceOverlay)
        )
        .onHover { isHovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(title))
        .accessibilityAction(named: Text("Dismiss"), onDismiss)
    }
}
