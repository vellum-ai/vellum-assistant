import SwiftUI
import VellumAssistantShared

/// Compact inline banner promoting the Vellum Discord community, rendered
/// above the composer in ChatView. Single-row layout: icon + text on the
/// left, "Join Discord" button + dismiss on the right.
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
        HStack(spacing: VSpacing.sm) {
            discordIcon
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 0) {
                Text("Join our community!")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentEmphasized)

                Text("Talk to the team — share feedback, request features, get answers faster")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(1)
            }
            .layoutPriority(1)

            Spacer(minLength: 0)

            VButton(
                label: "Join Discord",
                style: .primary,
                size: .compact
            ) {
                onJoin()
            }
            .accessibilityLabel("Join Discord community")

            Button {
                onDismiss()
            } label: {
                VIconView(.x, size: 14)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityLabel("Dismiss Discord banner")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
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
