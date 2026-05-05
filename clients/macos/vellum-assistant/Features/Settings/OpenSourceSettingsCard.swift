import SwiftUI
import VellumAssistantShared

/// `@AppStorage` key for the GitHub-nudge "starred" flag. Persisted to
/// `UserDefaults.standard` and currently used as a record that the user
/// clicked the "Star on GitHub" CTA — read by no surface today. The key
/// name mirrors the web app's `app.githubNudge.starred` `localStorage`
/// key as a per-platform naming convention; the two stores are separate.
enum GitHubNudge {
    static let starredKey = "app.githubNudge.starred"
}

/// One row of an `OpenSourceSettingsCard` benefit list — icon swatch +
/// description sentence. Extracted as a private view (not a modifier) so
/// every row in every nudge stays visually identical.
private struct BenefitRow: View {
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

/// Settings card promoting the open-source GitHub repo. Always visible
/// (no dismissal) — it's a permanent home for the source-code link in
/// Settings, the same way `IOSAppCard` / `MacOSAppCard` stay visible on
/// the web platform after the user downloads the app.
struct OpenSourceSettingsCard: View {
    @AppStorage(GitHubNudge.starredKey) private var starred: Bool = false
    @Environment(\.openURL) private var openURL

    private static let benefits: [(icon: VIcon, text: String)] = [
        (.github, "Read the source on GitHub"),
        (.star, "Star the repo to follow updates"),
        (.gitPullRequest, "Open issues, contribute fixes and features"),
    ]

    var body: some View {
        SettingsCard(
            title: "Open Source",
            subtitle: "Vellum is open source — help us build it."
        ) {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    ForEach(Self.benefits, id: \.text) { benefit in
                        BenefitRow(icon: benefit.icon, text: benefit.text)
                    }
                }
                VButton(
                    label: "Star on GitHub",
                    leftIcon: VIcon.star.rawValue,
                    style: .primary
                ) {
                    starred = true
                    openURL(AppURLs.repositoryURL)
                }
            }
        }
    }
}
