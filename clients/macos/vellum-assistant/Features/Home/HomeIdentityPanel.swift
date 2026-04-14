import SwiftUI
import VellumAssistantShared

/// Left-column identity panel on the Home page.
///
/// Composes the relationship "who am I" summary as a vertical column: a
/// progress ring wrapping an avatar placeholder, the assistant name, a tagline
/// derived from the tier description, the tappable tier badge, and a tiny
/// metadata strip ("Hatched X ago" + conversation count). When the user has
/// never had a conversation, a "Start a conversation" call-to-action button is
/// surfaced inline.
///
/// This view is deliberately store-free — it takes a fully-materialised
/// `RelationshipState` plus an `onStartConversation` closure so it can be
/// rendered from tests without wiring in any observable dependencies.
struct HomeIdentityPanel: View {
    let state: RelationshipState
    let onStartConversation: () -> Void

    /// Pulls the user's actual configured avatar (custom upload, character
    /// traits, or fallback initial-letter image) so the Home page reads as
    /// "this is your assistant" rather than a generic placeholder.
    private let appearance = AvatarAppearanceManager.shared

    private var tier: RelationshipTier {
        RelationshipTier(rawValue: state.tier) ?? .gettingToKnowYou
    }

    private var progress: Double {
        Double(state.progressPercent) / 100.0
    }

    private var tagline: String {
        tier.descriptionText
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
        VStack(alignment: .center, spacing: VSpacing.lg) {
            ringSection
            nameAndTagline
            TierBadgeView(tier: tier)
            metadataDivider
            metadataSection
            if state.conversationCount == 0 {
                VButton(
                    label: "Start a conversation",
                    style: .primary,
                    size: .regular,
                    isFullWidth: true,
                    action: onStartConversation
                )
                .padding(.top, VSpacing.xs)
            }
        }
        .frame(width: 220)
    }

    // MARK: - Ring + avatar

    /// Diameter of the entire ring frame. The avatar inside renders inset so
    /// the ring stroke wraps around it with a small breathing gap.
    private let ringDiameter: CGFloat = 132

    /// Inset between the ring stroke and the avatar — picks up the warm
    /// background color so the avatar appears to "sit" inside the ring.
    private let avatarInset: CGFloat = 10

    private var ringSection: some View {
        ProgressRingView(progress: progress) {
            avatarContent
        }
        .frame(width: ringDiameter, height: ringDiameter)
        .padding(.bottom, VSpacing.xs)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Relationship progress"))
        .accessibilityValue(Text("\(min(max(state.progressPercent, 0), 100)) percent"))
    }

    /// Real assistant avatar — custom upload, character traits (animated
    /// `AnimatedAvatarView`), or initial-letter fallback. Resolution mirrors
    /// `ChatEmptyStateView.heroSection` so the Home page and the chat empty
    /// state always show the same visual identity.
    @ViewBuilder
    private var avatarContent: some View {
        let avatarSize = ringDiameter - (avatarInset * 2)
        Group {
            if appearance.customAvatarImage != nil {
                VAvatarImage(
                    image: appearance.fullAvatarImage,
                    size: avatarSize,
                    showBorder: false
                )
            } else if let body = appearance.characterBodyShape,
                      let eyes = appearance.characterEyeStyle,
                      let color = appearance.characterColor {
                AnimatedAvatarView(
                    bodyShape: body,
                    eyeStyle: eyes,
                    color: color,
                    size: avatarSize
                )
                .frame(width: avatarSize, height: avatarSize)
            } else {
                VAvatarImage(
                    image: appearance.fullAvatarImage,
                    size: avatarSize,
                    showBorder: false
                )
            }
        }
        .frame(width: avatarSize, height: avatarSize)
    }

    // MARK: - Name + tagline

    private var nameAndTagline: some View {
        VStack(alignment: .center, spacing: VSpacing.xxs) {
            Text(state.assistantName)
                .font(VFont.titleLarge)
                .foregroundStyle(VColor.contentEmphasized)
                .lineLimit(1)
                .truncationMode(.tail)
            Text(tagline)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Metadata

    private var metadataDivider: some View {
        Rectangle()
            .fill(VColor.borderBase)
            .frame(height: 1)
            .padding(.horizontal, VSpacing.xxl)
    }

    private var metadataSection: some View {
        VStack(alignment: .center, spacing: VSpacing.xxs) {
            Text(hatchedRelative)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentTertiary)
            Text(conversationCountLabel)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .frame(maxWidth: .infinity)
    }
}
