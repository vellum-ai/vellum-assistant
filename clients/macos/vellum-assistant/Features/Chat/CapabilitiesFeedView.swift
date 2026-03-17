import SwiftUI
import VellumAssistantShared

/// Masonry-style grid of capability cards grouped by category.
/// Shows skeleton placeholders for categories still generating.
struct CapabilitiesFeedView: View {
    let cards: [CapabilityCard]
    let categoryStatuses: [String: CategoryStatus]
    let loading: Bool
    let onCardTap: (CapabilityCard) -> Void

    /// Categories in display order.
    private static let categoryOrder = [
        "communication",
        "productivity",
        "development",
        "automation",
        "web_social",
        "integration",
        "media",
    ]

    /// Human-readable category labels.
    private static let categoryLabels: [String: String] = [
        "communication": "Communication",
        "productivity": "Productivity",
        "development": "Development",
        "media": "Media",
        "automation": "Automation",
        "web_social": "Web & Social",
        "integration": "Integration",
    ]

    private let columns = [
        GridItem(.flexible(), spacing: VSpacing.md),
        GridItem(.flexible(), spacing: VSpacing.md),
        GridItem(.flexible(), spacing: VSpacing.md),
    ]

    /// Cards grouped by category in display order, filtered to relevant categories.
    private var groupedCards: [(category: String, label: String, cards: [CapabilityCard])] {
        let byCategory = Dictionary(grouping: cards, by: { $0.category ?? "other" })
        return Self.categoryOrder.compactMap { cat in
            guard let items = byCategory[cat], !items.isEmpty else { return nil }
            let label = Self.categoryLabels[cat] ?? cat.capitalized
            return (category: cat, label: label, cards: items)
        }
    }

    /// Categories that are still generating (no cards yet, status is "generating").
    private var generatingCategories: [String] {
        Self.categoryOrder.filter { cat in
            let status = categoryStatuses[cat]
            let hasCards = cards.contains { $0.category == cat }
            return !hasCards && status?.status == "generating"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            // Section header
            VStack(alignment: .center, spacing: VSpacing.xs) {
                Text("Everything I can do for you")
                    .font(VFont.title)
                    .foregroundColor(VColor.contentDefault)

                Text("Personalized for you \u{00B7} Tap any card to start")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }
            .frame(maxWidth: .infinity)
            .padding(.bottom, VSpacing.md)

            // Cards grouped by category
            ForEach(groupedCards, id: \.category) { group in
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text(group.label)
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.contentTertiary)
                        .textCase(.uppercase)
                        .tracking(0.5)

                    LazyVGrid(columns: columns, spacing: VSpacing.md) {
                        ForEach(group.cards) { card in
                            CapabilityCardView(card: card) {
                                onCardTap(card)
                            }
                        }
                    }
                }
            }

            // Skeleton placeholders for categories still generating
            ForEach(generatingCategories, id: \.self) { cat in
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text(Self.categoryLabels[cat] ?? cat.capitalized)
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.contentTertiary)
                        .textCase(.uppercase)
                        .tracking(0.5)

                    LazyVGrid(columns: columns, spacing: VSpacing.md) {
                        ForEach(0..<2, id: \.self) { _ in
                            CapabilityCardSkeleton()
                        }
                    }
                }
            }

            // Loading state when no cards or generating categories exist yet
            if cards.isEmpty && generatingCategories.isEmpty && loading {
                LazyVGrid(columns: columns, spacing: VSpacing.md) {
                    ForEach(0..<6, id: \.self) { _ in
                        CapabilityCardSkeleton()
                    }
                }
            }

            // Soft closer
            if !cards.isEmpty {
                Text("And anything else you can dream up.")
                    .font(.custom("Fraunces", size: 16).italic())
                    .foregroundColor(VColor.contentTertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, VSpacing.lg)
                    .padding(.bottom, VSpacing.xxxl)
            }
        }
        .frame(maxWidth: VSpacing.chatBubbleMaxWidth + 200) // Wider than hero for 3-col grid
        .padding(.horizontal, VSpacing.xl)
    }
}
