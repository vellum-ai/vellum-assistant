import SwiftUI
import VellumAssistantShared

/// Right-hand detail panel surfaced when a `.nudge` feed item is tapped
/// on the redesigned Home page.
///
/// Matches Figma node `3679:21642` (right-hand side panel): the same
/// shell treatment as ``HomeScheduledDetailPanel`` — surface-lift card
/// with a `VRadius.xl` corner and a `borderHover` stroke, a header
/// (26pt tinted nudge icon + title + outlined close button), a scrolling
/// body with an optional intro description followed by a stack of N
/// cards, and a right-aligned footer with a secondary + primary action.
///
/// Each card (``Card``) carries its own title, description, and 0..N
/// optional actions. Actions are passed through as value types so the
/// view stays `Hashable`; the single `onCardAction` closure dispatches
/// by `(Card, CardAction)` pair.
///
/// Like ``HomeScheduledDetailPanel``, this component takes its data
/// shape as-is from the view layer — the feed wire format does not yet
/// carry rich card content, so callers supply placeholder cards while
/// the assistant follow-up lands (TODO in the PanelCoordinator call
/// site).
struct HomeNudgeDetailPanel: View {
    /// One issue/action card inside the body.
    struct Card: Identifiable, Hashable {
        let id: String
        let title: String
        let description: String
        let actions: [CardAction]
    }

    /// A single action button rendered inside a card's footer row.
    /// Closures aren't `Hashable`, so this carries only the display
    /// metadata — dispatch happens via the panel's `onCardAction`.
    struct CardAction: Identifiable, Hashable {
        enum Style: Hashable {
            /// Filled, `VColor.contentEmphasized` background.
            case primary
            /// Outlined, `VColor.borderElement` stroke.
            case secondary
        }
        let id: String
        let label: String
        let style: Style
    }

    let title: String
    let icon: VIcon
    let iconForeground: Color
    let iconBackground: Color
    /// Optional intro paragraph above the cards (e.g. "Found some issues.").
    let description: String?
    let cards: [Card]
    /// Primary footer action label (e.g. "Resolve All").
    let primaryActionLabel: String
    /// Optional secondary footer action label (e.g. "Clear All"). When
    /// nil, only the primary button renders.
    let secondaryActionLabel: String?
    let onClose: () -> Void
    let onPrimaryAction: () -> Void
    let onSecondaryAction: (() -> Void)?
    /// Fired when the user taps a card's action button. The panel can't
    /// store per-action closures without breaking Hashable, so callers
    /// dispatch on `(card.id, action.id)` here.
    let onCardAction: (Card, CardAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            Rectangle()
                .fill(VColor.borderHover)
                .frame(height: 1)
                .accessibilityHidden(true)

            ScrollView {
                bodySection
            }

            footer
        }
        .frame(minWidth: 480, idealWidth: 600, maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                .fill(VColor.surfaceLift)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                .strokeBorder(VColor.borderHover, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(title))
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .center) {
            HStack(spacing: VSpacing.sm) {
                ZStack {
                    Circle().fill(iconBackground)
                    VIconView(icon, size: 12)
                        .foregroundStyle(iconForeground)
                }
                .frame(width: 26, height: 26)
                .accessibilityHidden(true)

                Text(title)
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentEmphasized)
                    .accessibilityAddTraits(.isHeader)
            }

            Spacer(minLength: 0)

            Button(action: onClose) {
                ZStack {
                    RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                        .strokeBorder(VColor.borderElement, lineWidth: 1)
                    VIconView(.x, size: 9)
                        .foregroundStyle(VColor.contentEmphasized)
                }
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityLabel(Text("Close"))
        }
        .padding(VSpacing.lg)
    }

    // MARK: - Body

    private var bodySection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            if let description, !description.isEmpty {
                Text(description)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(cards) { card in
                    cardView(card)
                }
            }
        }
        .padding(EdgeInsets(
            top: VSpacing.lg,
            leading: VSpacing.lg,
            bottom: VSpacing.lg,
            trailing: VSpacing.lg
        ))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func cardView(_ card: Card) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text(card.title)
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentEmphasized)
                .accessibilityAddTraits(.isHeader)

            Text(card.description)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .fixedSize(horizontal: false, vertical: true)

            if !card.actions.isEmpty {
                HStack(alignment: .center, spacing: VSpacing.sm) {
                    ForEach(card.actions) { action in
                        cardActionButton(card: card, action: action)
                    }
                }
            }
        }
        .padding(EdgeInsets(
            top: VSpacing.md,
            leading: VSpacing.md,
            bottom: VSpacing.lg,
            trailing: VSpacing.md
        ))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg, style: .continuous)
                .fill(VColor.surfaceOverlay)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg, style: .continuous)
                .strokeBorder(VColor.borderHover, lineWidth: 1)
        )
    }

    private func cardActionButton(card: Card, action: CardAction) -> some View {
        Button(action: { onCardAction(card, action) }) {
            Text(action.label)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(action.style == .primary ? VColor.contentInset : VColor.contentEmphasized)
                .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
                .frame(height: 32)
                .background(
                    Group {
                        if action.style == .primary {
                            RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                                .fill(VColor.contentEmphasized)
                        }
                    }
                )
                .overlay(
                    Group {
                        if action.style == .secondary {
                            RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                                .strokeBorder(VColor.borderElement, lineWidth: 1)
                        }
                    }
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .accessibilityLabel(Text(action.label))
    }

    // MARK: - Footer

    private var footer: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(VColor.borderHover)
                .frame(height: 1)
                .accessibilityHidden(true)

            HStack(alignment: .center, spacing: VSpacing.sm) {
                Spacer()

                if let secondaryActionLabel {
                    Button(action: { onSecondaryAction?() }) {
                        Text(secondaryActionLabel)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentEmphasized)
                            .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
                            .frame(height: 32)
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                                    .strokeBorder(VColor.borderElement, lineWidth: 1)
                            )
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                    .accessibilityLabel(Text(secondaryActionLabel))
                }

                Button(action: onPrimaryAction) {
                    Text(primaryActionLabel)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentInset)
                        .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
                        .frame(height: 32)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                                .fill(VColor.contentEmphasized)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .accessibilityLabel(Text(primaryActionLabel))
            }
            .padding(VSpacing.lg)
        }
    }
}
