import SwiftUI
import VellumAssistantShared

/// Full card component for nudge-type feed items, showing an icon, title,
/// summary text, action buttons, and a dismiss control.
struct HomeNudgeCard: View {
    let item: FeedItem
    let onDismiss: () -> Void
    let onAction: (String) -> Void

    var body: some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                // Header: icon + title + dismiss
                HStack(alignment: .top, spacing: VSpacing.sm) {
                    VIconView(.sparkles, size: 20)
                        .foregroundStyle(VColor.primaryBase)

                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text(item.title)
                            .font(VFont.titleSmall)
                            .foregroundStyle(VColor.contentEmphasized)

                        Text(item.summary)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentSecondary)
                            .lineLimit(3)
                    }

                    Spacer(minLength: VSpacing.xs)

                    VButton(
                        label: "Dismiss",
                        iconOnly: VIcon.x.rawValue,
                        style: .ghost,
                        action: onDismiss
                    )
                    .controlSize(.small)
                }

                // Action buttons
                if let actions = item.actions, !actions.isEmpty {
                    HStack(spacing: VSpacing.sm) {
                        ForEach(actions) { action in
                            VButton(
                                label: action.label,
                                style: .outlined,
                                size: .compact,
                                action: { onAction(action.id) }
                            )
                        }
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Nudge: \(item.title)")
    }
}
