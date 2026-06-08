import SwiftUI
import VellumAssistantShared

/// Community settings tab — hero banner, side-by-side Open Source / Discord
/// feature cards, and a "More from Vellum" resource grid.
struct SettingsCommunityTab: View {
    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            CommunityHeroBanner()

            HStack(alignment: .top, spacing: VSpacing.lg) {
                OpenSourceFeatureCard()
                DiscordFeatureCard()
            }

            MoreFromVellumSection()
        }
    }
}

// MARK: - Hero Banner

private struct CommunityHeroBanner: View {
    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            CommunityBadge()

            Text("Build with us, in the open.")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(VColor.contentEmphasized)

            Text("Vellum is built in the open with a growing community of developers, designers, and tinkerers. Here's how to get involved.")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentTertiary)
                .frame(maxWidth: 480, alignment: .leading)
        }
        .padding(VSpacing.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }
}

/// Small pill badge with a play icon and "Community" label.
private struct CommunityBadge: View {
    var body: some View {
        HStack(spacing: VSpacing.xs) {
            VIcon.play.image(size: 12)
                .foregroundStyle(VColor.contentSecondary)
            Text("Community")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentDefault)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            Capsule()
                .fill(VColor.surfaceBase)
        )
    }
}

// MARK: - Benefit Row

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

// MARK: - Feature Card

private struct FeatureCardContainer<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            content()
        }
        .padding(VSpacing.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }
}

private struct FeatureCardHeader: View {
    let icon: VIcon
    let iconBg: Color
    var iconFg: Color = VColor.auxWhite
    let label: String

    var body: some View {
        HStack {
            ZStack {
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(iconBg)
                    .frame(width: 40, height: 40)
                icon.image(size: 20)
                    .foregroundStyle(iconFg)
            }
            Spacer()
            Text(label)
                .font(VFont.labelDefault)
                .textCase(.uppercase)
                .tracking(1)
                .foregroundStyle(VColor.contentTertiary)
        }
    }
}

// MARK: - Open Source Card

private struct OpenSourceFeatureCard: View {
    @AppStorage(GitHubNudge.starredKey) private var starred: Bool = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        FeatureCardContainer {
            FeatureCardHeader(
                icon: .github,
                iconBg: VColor.contentEmphasized,
                iconFg: VColor.surfaceBase,
                label: "Open Source"
            )

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Vellum is open source")
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentEmphasized)
                Text("Read the source, star the repo, and contribute fixes and features on GitHub.")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentTertiary)
            }

            VStack(alignment: .leading, spacing: VSpacing.md) {
                BenefitRow(icon: .star, text: "Star the repo to follow updates")
                BenefitRow(icon: .bug, text: "Open issues and report bugs")
                BenefitRow(icon: .gitPullRequest, text: "Contribute fixes and new features")
            }

            HStack(spacing: VSpacing.sm) {
                VButton(
                    label: "Star on GitHub",
                    leftIcon: VIcon.star.rawValue,
                    style: .primary
                ) {
                    starred = true
                    openURL(AppURLs.repositoryURL)
                }
                VButton(
                    label: "View source",
                    rightIcon: VIcon.arrowUpRight.rawValue,
                    style: .ghost
                ) {
                    openURL(AppURLs.repositoryURL)
                }
            }
        }
    }
}

// MARK: - Discord Card

private struct DiscordFeatureCard: View {
    @AppStorage(DiscordNudge.joinedKey) private var joined: Bool = false
    @Environment(\.openURL) private var openURL

    private static let discordBlue = Color(red: 88 / 255, green: 101 / 255, blue: 242 / 255)

    var body: some View {
        FeatureCardContainer {
            FeatureCardHeader(
                icon: .discord,
                iconBg: Self.discordBlue,
                label: "Discord"
            )

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Join our community")
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentEmphasized)
                Text("Talk to the team, share feedback, request features, and get answers faster.")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentTertiary)
            }

            VStack(alignment: .leading, spacing: VSpacing.md) {
                BenefitRow(icon: .heart, text: "Talk directly with the team")
                BenefitRow(icon: .sparkles, text: "Share feedback and request features")
                BenefitRow(icon: .users, text: "Get answers faster from the community")
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

// MARK: - More from Vellum

private struct MoreFromVellumSection: View {
    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text("MORE FROM VELLUM")
                .font(VFont.labelDefault)
                .tracking(1)
                .foregroundStyle(VColor.contentTertiary)

            HStack(alignment: .top, spacing: VSpacing.lg) {
                ResourceCard(
                    icon: .globe,
                    iconBg: Color(red: 34 / 255, green: 197 / 255, blue: 94 / 255),
                    title: "Community Hub",
                    description: "Showcases, guides, and projects shared by the community.",
                    url: AppURLs.communityHubURL
                )
                ResourceCard(
                    icon: .xBrand,
                    iconBg: Color(red: 15 / 255, green: 23 / 255, blue: 42 / 255),
                    title: "Follow on X",
                    description: "Product updates, releases, and behind-the-scenes.",
                    url: AppURLs.twitterURL
                )
                ResourceCard(
                    icon: .circlePlay,
                    iconBg: Color(red: 239 / 255, green: 68 / 255, blue: 68 / 255),
                    title: "YouTube channel",
                    description: "Walkthroughs, tutorials, and product deep-dives.",
                    url: AppURLs.youtubeURL
                )
            }
        }
    }
}

private struct ResourceCard: View {
    let icon: VIcon
    let iconBg: Color
    let title: String
    let description: String
    let url: URL

    @Environment(\.openURL) private var openURL
    @State private var isHovered = false

    var body: some View {
        Button {
            openURL(url)
        } label: {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                HStack {
                    ZStack {
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .fill(iconBg)
                            .frame(width: 40, height: 40)
                        icon.image(size: 20)
                            .foregroundStyle(VColor.auxWhite)
                    }
                    Spacer()
                    VIcon.externalLink.image(size: 14)
                        .foregroundStyle(VColor.contentTertiary)
                }

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text(title)
                        .font(VFont.titleSmall)
                        .foregroundStyle(VColor.contentEmphasized)
                    Text(description)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentTertiary)
                        .lineLimit(2)
                }
            }
            .padding(VSpacing.xl)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .vCard()
        .shadow(color: isHovered ? VColor.contentEmphasized.opacity(0.08) : .clear, radius: 8, y: 2)
        .onHover { hovering in
            isHovered = hovering
            if hovering {
                NSCursor.pointingHand.push()
            } else {
                NSCursor.pop()
            }
        }
    }
}
