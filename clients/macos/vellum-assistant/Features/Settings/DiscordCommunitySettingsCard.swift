import SwiftUI
import VellumAssistantShared

/// `@AppStorage` keys for the Discord community nudge. Persisted to
/// `UserDefaults.standard`. The key names mirror the web app's
/// `app.discordNudge.*` `localStorage` keys as a per-platform naming
/// convention; the two stores are separate.
enum DiscordNudge {
    static let joinedKey = "app.discordNudge.joined"
    static let bannerDismissedKey = "app.discordNudge.bannerDismissed"
}

/// Settings card promoting the Vellum Discord community. Always visible
/// (no dismissal) — a permanent home for the community link in Settings,
/// matching the `OpenSourceSettingsCard` pattern.
struct DiscordCommunitySettingsCard: View {
    @AppStorage(DiscordNudge.joinedKey) private var joined: Bool = false
    @Environment(\.openURL) private var openURL

    private static let benefits: [(icon: VIcon, text: String)] = [
        (.messagesSquare, "Talk directly with the team"),
        (.star, "Share feedback and request features"),
        (.circleCheck, "Get answers faster from the community"),
    ]

    var body: some View {
        SettingsCard(
            title: "Join our community!",
            subtitle: "Talk to the team — share feedback, request features, get answers faster."
        ) {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    ForEach(Self.benefits, id: \.text) { benefit in
                        DiscordBenefitRow(icon: benefit.icon, text: benefit.text)
                    }
                }
                VButton(
                    label: "Join Discord",
                    leftIcon: VIcon.discord.rawValue,
                    style: .primary
                ) {
                    joined = true
                    openURL(AppURLs.discordInviteURL)
                }
            }
        }
    }
}

/// One row of a `DiscordCommunitySettingsCard` benefit list — icon swatch +
/// description sentence. Mirrors the `BenefitRow` in `OpenSourceSettingsCard`.
private struct DiscordBenefitRow: View {
    let icon: VIcon
    let text: String

    var body: some View {
        HStack(spacing: VSpacing.md) {
            ZStack {
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(VColor.surfaceBase)
                    .frame(width: 28, height: 28)
                icon.image(size: 14)
                    .foregroundStyle(VColor.contentSecondary)
            }
            .accessibilityHidden(true)
            Text(text)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
