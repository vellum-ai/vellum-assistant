import SwiftUI
import VellumAssistantShared

/// Full-bleed card that renders a `FeedItem` whose `type == .nudge`.
///
/// Nudges are the highest-signal feed surface: they nearly always carry 1–2
/// action buttons the assistant wants the user to tap straight from the Home
/// page (e.g. "Draft reply", "Snooze"). This view gives them a raised card
/// treatment so they visually dominate the compact digest/action/thread rows
/// rendered by `HomeFeedListRow`.
///
/// Layout (top → bottom):
///
///   icon · title · spacer · dismiss (X)
///   summary
///   [action button]  [action button]
///
/// The view is intentionally pure — it takes the `FeedItem`, an `onAction`
/// closure invoked with the tapped `FeedAction`, and an `onDismiss` closure.
/// No store coupling lives here; the wiring PR binds it to `HomeFeedStore`.
struct HomeFeedNudgeCard: View {
    let item: FeedItem
    let onAction: (FeedAction) -> Void
    let onDismiss: () -> Void

    /// Cap the visible action buttons at two per the TDD's "1–2 max" rule so
    /// a malformed feed item can never push a wall of buttons into the card.
    private var visibleActions: [FeedAction] {
        let actions = item.actions ?? []
        return Array(actions.prefix(2))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            headerRow
            summaryText
            if !visibleActions.isEmpty {
                actionsRow
            }
        }
        .padding(VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.window, style: .continuous)
                .fill(VColor.surfaceLift)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.window, style: .continuous)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(item.title))
        .accessibilityHint(Text(item.summary))
    }

    // MARK: - Header

    private var headerRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: VSpacing.sm) {
            HomeFeedItemIcon(source: item.source)
            Text(item.title)
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentEmphasized)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: VSpacing.sm)

            VButton(
                label: "Dismiss",
                iconOnly: VIcon.x.rawValue,
                style: .ghost,
                size: .compact,
                tintColor: VColor.contentTertiary,
                action: onDismiss
            )
            .accessibilityLabel(Text("Dismiss"))
        }
    }

    // MARK: - Summary

    private var summaryText: some View {
        Text(item.summary)
            .font(VFont.bodyMediumDefault)
            .foregroundStyle(VColor.contentDefault)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Actions

    private var actionsRow: some View {
        HStack(spacing: VSpacing.sm) {
            ForEach(Array(visibleActions.enumerated()), id: \.element.id) { index, action in
                VButton(
                    label: action.label,
                    style: index == 0 ? .primary : .outlined,
                    size: .compact
                ) {
                    onAction(action)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.top, VSpacing.xxs)
    }
}
