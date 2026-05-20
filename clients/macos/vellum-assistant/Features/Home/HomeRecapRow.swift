import SwiftUI
import VellumAssistantShared

/// Compact row used in the time-bucketed Home feed.
///
/// Layout: a 26pt tinted icon circle + a single-line title + a fixed-width
/// trailing timestamp + a hover-only Dismiss affordance + a whole-row tap
/// target. The row itself is intentionally slim (icon pill drives the
/// height) so a list of recaps reads as a dense time-feed rather than a
/// stack of cards.
///
/// The Dismiss affordance appears only while the pointer is over the row
/// (Figma `3596:79329` — hover state). Its tap is isolated from the outer
/// row Button so clicking "Dismiss" never fires the row's `onTap` — SwiftUI
/// resolves the innermost tappable first. The timestamp uses a fixed
/// width so the title doesn't reflow when the dismiss affordance appears.
struct HomeRecapRow: View {
    /// Hover-only trailing affordance. `.dismiss` is the default (X icon,
    /// "Dismiss" label); `.restore` is used by the Dismissed disclosure
    /// to bring a row back into the active feed.
    enum TrailingAction {
        case dismiss
        case restore

        var icon: VIcon { self == .restore ? .rotateCcw : .x }
        var label: String { self == .restore ? "Restore" : "Dismiss" }
    }

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
    /// Event time used to render a relative-time label ("2h ago",
    /// "just now") in the trailing metadata slot.
    let timestamp: Date
    /// Lifecycle state — `.new` rows render the title in an emphasised
    /// weight so unread items stand out from ones the user has seen.
    let status: FeedItemStatus
    /// When `true`, paint a negative-weak row background tint so urgent
    /// items pop in a dense feed — a 6pt red dot alone is too quiet for
    /// `urgency >= .high` items.
    var isUrgent: Bool = false
    /// When `true`, render the persona avatar in the leading icon slot
    /// instead of the category icon circle. Used for assistant-initiated
    /// feed rows (`FeedItem.fromAssistant == true`) so the surface reads
    /// as "your assistant sent this" rather than a generic system bell.
    var showsPersonaAvatar: Bool = false
    var trailingAction: TrailingAction = .dismiss
    let onDismiss: () -> Void
    let onTap: () -> Void

    @State private var isHovering: Bool = false

    private var titleFont: Font {
        status == .new ? VFont.bodyMediumEmphasised : VFont.bodyMediumDefault
    }

    private var backgroundFill: Color {
        if isUrgent { return VColor.systemNegativeWeak }
        return isHovering ? VColor.surfaceLift : VColor.surfaceOverlay
    }

    /// Dim only the decorative icon for read rows — blanket-fading the
    /// row would drop title/timestamp contrast below WCAG minimums on
    /// `surfaceOverlay`. Unread vs. read is already signalled by the
    /// title font weight (see `titleFont`).
    private var iconOpacity: Double {
        if isUrgent { return 1.0 }
        return status == .new ? 1.0 : 0.55
    }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: VSpacing.sm) {
                leadingIcon
                    .frame(width: 26, height: 26)
                    .opacity(iconOpacity)

                Text(title)
                    // Mock uses #A9B2BB which is `contentSecondary` in the
                    // dark palette (see ColorTokens.swift).
                    .font(titleFont)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: VSpacing.sm)

                Text(timestamp.relativeShortString())
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineLimit(1)
                    // Fixed width keeps the timestamp anchored when the
                    // dismiss affordance appears on hover.
                    .frame(width: 64, alignment: .trailing)
                    .accessibilityHidden(true)

                if isHovering {
                    // Wrapping the trailing affordance in its own Button
                    // keeps the tap from bubbling to the outer row Button —
                    // SwiftUI resolves the innermost tappable first.
                    Button(action: onDismiss) {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(trailingAction.icon, size: 7)
                                .foregroundStyle(VColor.contentDisabled)
                            Text(trailingAction.label)
                                .font(VFont.bodySmallDefault)
                                .foregroundStyle(VColor.contentDisabled)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                    .accessibilityLabel(Text(trailingAction.label))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.md, bottom: VSpacing.sm, trailing: VSpacing.md))
        .background(
            RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                .fill(backgroundFill)
        )
        .onHover { isHovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(isUrgent ? "Urgent, \(title)" : title))
        .accessibilityAction(named: Text(trailingAction.label), onDismiss)
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
