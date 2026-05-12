import SwiftUI
import VellumAssistantShared

/// Inline banner promoting the Vellum Discord community, rendered above the
/// composer in ChatView. Follows the same visual pattern as
/// `RecoveryModeBanner` and `MissingApiKeyBanner`: anchored at the bottom
/// of the message list with a rounded-top card.
///
/// Shown when:
/// - User has not joined Discord (`app.discordNudge.joined` is false)
/// - User has not dismissed the banner (`app.discordNudge.bannerDismissed` is false)
/// - User has starred the GitHub repo (GitHub nudge resolved)
/// - User has at least 2 conversations
struct DiscordCommunityBanner: View {
    let onJoin: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack(alignment: .top, spacing: VSpacing.sm) {
                discordIcon
                    .padding(.top, 1)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Join our community!")
                        .font(VFont.bodySmallEmphasised)
                        .foregroundStyle(VColor.contentEmphasized)

                    Text("Talk to the team — share feedback, request features, get answers faster.")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
                .layoutPriority(1)

                Spacer(minLength: 0)

                Button {
                    onDismiss()
                } label: {
                    VIconView(.x, size: 14)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss Discord banner")
            }

            HStack(spacing: VSpacing.sm) {
                VButton(
                    label: "Join Discord",
                    style: .primary
                ) {
                    onJoin()
                }
                .accessibilityLabel("Join Discord community")
            }
        }
        .padding(VSpacing.lg)
        .background(VColor.surfaceActive)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: VRadius.lg,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: VRadius.lg
            )
        )
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .accessibilityElement(children: .contain)
    }

    /// Discord logo loaded from the bundled integration assets.
    /// Falls back to a generic message icon if the asset is unavailable.
    private var discordIcon: some View {
        Group {
            if let nsImage = IntegrationLogoBundle.bundledImage(providerKey: "discord") {
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 16, height: 16)
            } else {
                VIconView(.messagesSquare, size: 14)
            }
        }
        .foregroundStyle(VColor.primaryBase)
    }
}
