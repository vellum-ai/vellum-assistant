import SwiftUI
import VellumAssistantShared

/// Concierge-style card feed built from `CapabilityFeedPresentation`.
///
/// Displays one hero recommendation, a small set of supporting cards,
/// and a collapsed overflow section — replacing the old category-grouped grid.
struct CapabilitiesFeedView: View {
    let cards: [CapabilityCard]
    let categoryStatuses: [String: CategoryStatus]
    let loading: Bool
    let onCardTap: (CapabilityCard) -> Void

    @State private var overflowExpanded = false

    private var presentation: CapabilityFeedPresentation {
        CapabilityFeedPresentation(cards: cards, categoryStatuses: categoryStatuses)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            heroSection

            supportingSection

            overflowSection

            loadingSection

            closerSection
        }
        .frame(maxWidth: VSpacing.chatBubbleMaxWidth + 80)
        .padding(.horizontal, VSpacing.xl)
    }

    // MARK: - Hero

    @ViewBuilder
    private var heroSection: some View {
        if let hero = presentation.hero {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                sectionHeader(FeedFraming.heroHeader, eyebrow: FeedFraming.currentHeroEyebrow)

                CapabilityCardView(card: hero, treatment: .hero) {
                    onCardTap(hero)
                }
            }
        }
    }

    // MARK: - Supporting

    @ViewBuilder
    private var supportingSection: some View {
        if !presentation.supporting.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                sectionHeader(FeedFraming.supportingHeader)

                ForEach(presentation.supporting) { card in
                    CapabilityCardView(card: card, treatment: .compact) {
                        onCardTap(card)
                    }
                }
            }
        }
    }

    // MARK: - Overflow

    @ViewBuilder
    private var overflowSection: some View {
        if !presentation.overflow.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Button {
                    withAnimation(VAnimation.standard) {
                        overflowExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: VSpacing.sm) {
                        Text(FeedFraming.overflowHeader)
                            .font(VFont.captionMedium)
                            .foregroundColor(VColor.contentTertiary)
                            .textCase(.uppercase)
                            .tracking(0.5)

                        Spacer()

                        VIcon.chevronDown.image
                            .resizable()
                            .frame(width: 12, height: 12)
                            .foregroundColor(VColor.contentTertiary)
                            .rotationEffect(.degrees(overflowExpanded ? 180 : 0))
                            .animation(VAnimation.standard, value: overflowExpanded)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    overflowExpanded
                        ? "Collapse more ideas"
                        : "Show \(presentation.overflow.count) more ideas"
                )

                if overflowExpanded {
                    ForEach(presentation.overflow) { card in
                        CapabilityCardView(card: card, treatment: .compact) {
                            onCardTap(card)
                        }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

    // MARK: - Loading

    @ViewBuilder
    private var loadingSection: some View {
        if cards.isEmpty && loading {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                CapabilityCardSkeleton(treatment: .hero)

                ForEach(0..<2, id: \.self) { _ in
                    CapabilityCardSkeleton(treatment: .compact)
                }
            }
        } else if presentation.isGenerating {
            CapabilityCardSkeleton(treatment: .compact)
        }
    }

    // MARK: - Closer

    @ViewBuilder
    private var closerSection: some View {
        if !cards.isEmpty {
            Text(FeedFraming.feedCloser)
                .font(.custom("Fraunces", size: 16).italic())
                .foregroundColor(VColor.contentTertiary)
                .frame(maxWidth: .infinity)
                .padding(.top, VSpacing.lg)
                .padding(.bottom, VSpacing.xxxl)
        }
    }

    // MARK: - Helpers

    @ViewBuilder
    private func sectionHeader(_ title: String, eyebrow: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            if let eyebrow {
                Text(eyebrow)
                    .font(VFont.small)
                    .foregroundColor(VColor.contentTertiary)
                    .italic()
            }

            Text(title)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.contentTertiary)
                .textCase(.uppercase)
                .tracking(0.5)
        }
    }
}
