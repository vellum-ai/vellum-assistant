import SwiftUI
import VellumAssistantShared

/// Community settings tab — consolidates Discord, GitHub, and external
/// community resource links into a single destination.
struct SettingsCommunityTab: View {
    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            DiscordCommunitySettingsCard()
            OpenSourceSettingsCard()
            CommunityResourcesCard()
        }
    }
}

// MARK: - Resources Card

/// Card listing additional community links (community hub, Twitter/X, YouTube).
private struct CommunityResourcesCard: View {
    private static let resources: [(icon: VIcon, title: String, subtitle: String, url: URL)] = [
        (.globe, "Community Hub", "Browse guides, tips, and success stories", AppURLs.communityHubURL),
        (.externalLink, "Twitter / X", "Follow for news and updates", AppURLs.twitterURL),
        (.circlePlay, "YouTube", "Watch tutorials and demos", AppURLs.youtubeURL),
    ]

    var body: some View {
        SettingsCard(
            title: "Resources",
            subtitle: "More from the Vellum community."
        ) {
            VStack(spacing: 0) {
                ForEach(Array(Self.resources.enumerated()), id: \.element.title) { index, resource in
                    if index > 0 {
                        SettingsDivider()
                    }
                    CommunityResourceRow(
                        icon: resource.icon,
                        title: resource.title,
                        subtitle: resource.subtitle,
                        url: resource.url
                    )
                }
            }
        }
    }
}

// MARK: - Resource Row

/// A single tappable row linking to an external community resource.
private struct CommunityResourceRow: View {
    let icon: VIcon
    let title: String
    let subtitle: String
    let url: URL

    @Environment(\.openURL) private var openURL
    @State private var isHovered = false

    var body: some View {
        Button {
            openURL(url)
        } label: {
            HStack(spacing: VSpacing.md) {
                ZStack {
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .fill(VColor.surfaceBase)
                        .frame(width: 28, height: 28)
                    icon.image(size: 14)
                        .foregroundStyle(VColor.contentSecondary)
                }
                .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentEmphasized)
                    Text(subtitle)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                }

                Spacer()

                VIcon.externalLink.image(size: 14)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .padding(.vertical, VSpacing.sm)
            .padding(.horizontal, VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isHovered ? VColor.surfaceActive : Color.clear)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovered = hovering
        }
    }
}
