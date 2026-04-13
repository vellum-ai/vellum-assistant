import SwiftUI
import VellumAssistantShared

/// Left-column identity panel on the home page.
///
/// Composes the relationship "who am I" summary: a progress ring wrapping the
/// assistant avatar, the assistant name + relationship tagline, the tier
/// badge, and a relative "hatched" / conversation-count metadata row. When the
/// user has never had a conversation, a "Start a conversation" call-to-action
/// button is surfaced inline.
///
/// This view is deliberately store-free — it takes a fully-materialised
/// `RelationshipState` plus an `onStartConversation` closure so it can be
/// rendered from tests and from the Component Gallery without wiring in any
/// observable dependencies.
struct HomeIdentityPanel: View {
    let state: RelationshipState
    let onStartConversation: () -> Void

    private var tier: RelationshipTier {
        RelationshipTier(rawValue: state.tier) ?? .gettingToKnowYou
    }

    private var progress: Double {
        Double(state.progressPercent) / 100.0
    }

    private var tagline: String {
        tier.descriptionText
    }

    private var avatarInitial: String {
        let trimmed = state.assistantName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "?" }
        return String(first).uppercased()
    }

    private var hatchedRelative: String {
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let parsed = isoFormatter.date(from: state.hatchedDate)
            ?? {
                let fallback = ISO8601DateFormatter()
                fallback.formatOptions = [.withInternetDateTime]
                return fallback.date(from: state.hatchedDate)
            }()
        guard let date = parsed else {
            return "Hatched recently"
        }
        let relative = RelativeDateTimeFormatter()
        relative.unitsStyle = .full
        let phrase = relative.localizedString(for: date, relativeTo: Date())
        return "Hatched \(phrase)"
    }

    private var conversationCountLabel: String {
        let count = state.conversationCount
        if count == 1 {
            return "1 conversation"
        }
        return "\(count) conversations"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            ringSection
            nameSection
            TierBadgeView(tier: tier)
            metadataSection
            if state.conversationCount == 0 {
                VButton(
                    label: "Start a conversation",
                    style: .primary,
                    size: .regular,
                    isFullWidth: true,
                    action: onStartConversation
                )
            }
        }
        .frame(width: 220)
    }

    // MARK: - Sections

    private var ringSection: some View {
        HStack {
            Spacer(minLength: 0)
            ProgressRingView(progress: progress) {
                avatarPlaceholder
            }
            .frame(width: 140, height: 140)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("Relationship progress"))
            .accessibilityValue(Text("\(state.progressPercent) percent"))
            Spacer(minLength: 0)
        }
    }

    private var avatarPlaceholder: some View {
        ZStack {
            Circle()
                .fill(VColor.funGreen.opacity(0.25))
            Text(avatarInitial)
                .font(VFont.titleLarge)
                .foregroundStyle(VColor.contentEmphasized)
        }
    }

    private var nameSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(state.assistantName)
                .font(VFont.titleLarge)
                .foregroundStyle(VColor.contentEmphasized)
                .lineLimit(1)
                .truncationMode(.tail)
            Text(tagline)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }

    private var metadataSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(hatchedRelative)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
            Text(conversationCountLabel)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
        }
    }
}
