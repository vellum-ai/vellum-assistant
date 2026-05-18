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
    /// Foreground color for the icon glyph. Callers pass one of the
    /// feed identifier tokens (e.g. `VColor.feedNudgeStrong`,
    /// `VColor.feedDigestStrong`, `VColor.feedThreadStrong`, or
    /// `VColor.systemInfoStrong` for `.action` items).
    let iconForeground: Color
    /// Tinted background fill for the icon circle (paired weak variant
    /// of the foreground token — e.g. `VColor.feedNudgeWeak`).
    let iconBackground: Color
    let title: String
    /// When `true`, render a leading red dot to flag an urgent inbox
    /// item (urgency `.high` or `.critical`). When `false`, the dot
    /// and its surrounding spacing are omitted entirely so non-urgent
    /// rows align flush with the icon circle (no spacing artifact).
    var isUrgent: Bool = false
    /// When `true`, render the persona avatar in the leading icon slot
    /// instead of the category icon circle. Used for assistant-initiated
    /// feed rows (`FeedItem.fromAssistant == true`) so the surface reads
    /// as "your assistant sent this" rather than a generic system bell.
    var showsPersonaAvatar: Bool = false
    let onDismiss: () -> Void
    let onTap: () -> Void

    @State private var isHovering: Bool = false

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: VSpacing.sm) {
                if isUrgent {
                    // Decorative — the row's combined accessibilityLabel
                    // below already announces "Urgent" before the title.
                    VBadge(style: .dot, color: VColor.systemNegativeStrong)
                        .accessibilityHidden(true)
                }
                leadingIcon
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
        .accessibilityLabel(Text(isUrgent ? "Urgent, \(title)" : title))
        .accessibilityAction(named: Text("Dismiss"), onDismiss)
    }

    /// 26pt leading slot: persona avatar for assistant-initiated rows,
    /// otherwise the tinted category icon circle. Both render into the
    /// same 26pt frame so toggling `showsPersonaAvatar` never shifts the
    /// row's horizontal layout.
    @ViewBuilder
    private var leadingIcon: some View {
        if showsPersonaAvatar {
            personaAvatar
        } else {
            ZStack {
                Circle().fill(iconBackground)
                VIconView(icon, size: 12)
                    .foregroundStyle(iconForeground)
            }
        }
    }

    /// Mirrors `HomePageView.greetingAvatar` but at 26pt. Falls back to
    /// the static avatar image when neither a custom image nor a full
    /// animated-character config is available.
    @ViewBuilder
    private var personaAvatar: some View {
        let appearance = AvatarAppearanceManager.shared
        let size: CGFloat = 26
        if appearance.customAvatarImage != nil {
            VAvatarImage(
                image: appearance.fullAvatarImage,
                size: size,
                showBorder: false
            )
        } else if let bodyShape = appearance.characterBodyShape,
                  let eyes = appearance.characterEyeStyle,
                  let color = appearance.characterColor {
            AnimatedAvatarView(
                bodyShape: bodyShape,
                eyeStyle: eyes,
                color: color,
                size: size,
                entryAnimationEnabled: false
            )
            .frame(width: size, height: size)
        } else {
            VAvatarImage(
                image: appearance.fullAvatarImage,
                size: size,
                showBorder: false
            )
        }
    }
}
