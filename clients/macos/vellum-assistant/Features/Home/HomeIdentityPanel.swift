import SwiftUI
import VellumAssistantShared

/// Left-column identity panel on the Home page.
///
/// Mirrors the avatar treatment from `IdentityPanel` so the assistant looks
/// the same wherever it appears: a large centered `AnimatedAvatarView` that
/// pops in via the entry animation, custom-upload override, or fallback
/// initial-letter image. Below the avatar a slim horizontal capsule progress
/// bar shows relationship progression — replacing the older ring treatment so
/// the avatar isn't visually constrained by a circle.
///
/// Stack order top-to-bottom: avatar → progress bar → assistant name +
/// tagline → tappable tier badge → divider → metadata strip → optional
/// "Start a conversation" zero-state button.
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
    @State private var appearance = AvatarAppearanceManager.shared

    private var tier: RelationshipTier {
        RelationshipTier(rawValue: state.tier) ?? .gettingToKnowYou
    }

    private var clampedProgress: Double {
        Double(min(max(state.progressPercent, 0), 100)) / 100.0
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
            avatarSection
            progressBar
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

    // MARK: - Avatar

    /// Rendered avatar diameter. Matches the visual weight the IdentityPanel
    /// gives its avatar in a similarly sized sidebar (~140pt for a 220pt
    /// column with comfortable horizontal padding).
    private let avatarSize: CGFloat = 140

    /// Mirrors the resolution chain in `IdentityPanel.swift` and
    /// `ChatEmptyStateView.heroSection`: custom upload first, then the
    /// `AnimatedAvatarView` built from character traits with the entry
    /// animation enabled (this is what gives the "pop in" feel), then the
    /// bundled initial-letter image as a final fallback.
    @ViewBuilder
    private var avatarSection: some View {
        Group {
            if appearance.customAvatarImage != nil {
                VAvatarImage(
                    image: appearance.fullAvatarImage,
                    size: avatarSize,
                    showBorder: false
                )
                .frame(maxWidth: .infinity, alignment: .center)
            } else if let body = appearance.characterBodyShape,
                      let eyes = appearance.characterEyeStyle,
                      let color = appearance.characterColor {
                AnimatedAvatarView(
                    bodyShape: body,
                    eyeStyle: eyes,
                    color: color,
                    size: avatarSize,
                    entryAnimationEnabled: true
                )
                .frame(width: avatarSize, height: avatarSize)
                .frame(maxWidth: .infinity, alignment: .center)
            } else {
                VAvatarImage(
                    image: appearance.fullAvatarImage,
                    size: avatarSize,
                    showBorder: false
                )
                .frame(maxWidth: .infinity, alignment: .center)
            }
        }
    }

    // MARK: - Progress bar

    /// Slim horizontal capsule progress bar replacing the older `ProgressRingView`.
    /// Sits directly under the avatar so the relationship progression reads as
    /// "loading toward something" instead of being trapped inside a ring.
    private var progressBar: some View {
        VStack(spacing: VSpacing.xxs) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(VColor.surfaceActive)
                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [
                                    VColor.funGreen.opacity(0.85),
                                    VColor.funGreen
                                ],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: geo.size.width * clampedProgress)
                        .animation(.easeOut(duration: 0.6), value: clampedProgress)
                }
            }
            .frame(height: 6)

            HStack {
                Text("Relationship")
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
                Spacer(minLength: 0)
                Text("\(min(max(state.progressPercent, 0), 100))%")
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, VSpacing.xs)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Relationship progress"))
        .accessibilityValue(Text("\(min(max(state.progressPercent, 0), 100)) percent"))
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
            .accessibilityHidden(true)
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
