import SwiftUI
import VellumAssistantShared

/// Visual treatment for a capability card in the concierge feed.
enum CardTreatment {
    /// Full-width, visually dominant card with stronger contrast and explicit CTA.
    case hero
    /// Lighter, scannable card for the supporting and overflow buckets.
    case compact
}

/// A single capability card with two visual treatments: hero and compact.
struct CapabilityCardView: View {
    let card: CapabilityCard
    var treatment: CardTreatment = .compact
    let onTap: () -> Void

    @State private var isHovered = false

    private var resolvedIcon: VIcon {
        VIcon.resolve(card.icon ?? "lucide-sparkles")
    }

    var body: some View {
        Button(action: onTap) {
            Group {
                switch treatment {
                case .hero:
                    heroContent
                case .compact:
                    compactContent
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(treatment == .hero ? VSpacing.xl : VSpacing.lg)
            .background(cardBackground)
            .overlay(cardBorder)
            .offset(y: isHovered ? -2 : 0)
            .shadow(
                color: isHovered ? VColor.borderBase.opacity(0.15) : .clear,
                radius: isHovered ? 8 : 0,
                y: isHovered ? 4 : 0
            )
            .animation(VAnimation.fast, value: isHovered)
            .contentShape(RoundedRectangle(cornerRadius: VRadius.lg))
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }

    // MARK: - Hero Treatment

    private var heroContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack(spacing: VSpacing.sm) {
                resolvedIcon.image
                    .resizable()
                    .frame(width: 20, height: 20)
                    .foregroundColor(VColor.primaryBase)

                Spacer()
            }

            Text(card.label)
                .font(VFont.cardTitle)
                .foregroundColor(VColor.contentEmphasized)
                .lineLimit(3)
                .multilineTextAlignment(.leading)

            if let desc = card.description, !desc.isEmpty {
                Text(desc)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
                    .lineLimit(4)
                    .multilineTextAlignment(.leading)
            }

            tagChips

            // CTA row
            HStack(spacing: VSpacing.xs) {
                Text("Start")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.primaryBase)

                VIcon.arrowRight.image
                    .resizable()
                    .frame(width: 12, height: 12)
                    .foregroundColor(VColor.primaryBase)
            }
            .padding(.top, VSpacing.xs)
        }
    }

    // MARK: - Compact Treatment

    private var compactContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                resolvedIcon.image
                    .resizable()
                    .frame(width: 16, height: 16)
                    .foregroundColor(VColor.contentSecondary)

                Text(card.label)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }

            if let desc = card.description, !desc.isEmpty {
                Text(desc)
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }

            tagChips
        }
    }

    // MARK: - Shared Elements

    @ViewBuilder
    private var tagChips: some View {
        if !card.tags.isEmpty {
            HStack(spacing: VSpacing.xs) {
                ForEach(card.tags, id: \.self) { tag in
                    Text(tag)
                        .font(VFont.small)
                        .foregroundColor(VColor.contentSecondary)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xxs)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.sm)
                                .fill(VColor.surfaceOverlay)
                        )
                }
            }
        }
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: VRadius.lg)
            .fill(isHovered ? VColor.surfaceOverlay : VColor.surfaceActive)
    }

    private var cardBorder: some View {
        RoundedRectangle(cornerRadius: VRadius.lg)
            .stroke(VColor.borderBase, lineWidth: 0.5)
    }
}

/// Skeleton placeholder for a card that is still being generated.
struct CapabilityCardSkeleton: View {
    var treatment: CardTreatment = .compact

    var body: some View {
        Group {
            switch treatment {
            case .hero:
                heroSkeleton
            case .compact:
                compactSkeleton
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(treatment == .hero ? VSpacing.xl : VSpacing.lg)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceActive)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.borderBase.opacity(0.3), lineWidth: 0.5)
        )
    }

    private var heroSkeleton: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            skeletonBone(width: 20, height: 20)
            skeletonBone(width: 200, height: 18)
            skeletonBone(height: 14)
            skeletonBone(width: 160, height: 14)
        }
    }

    private var compactSkeleton: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                skeletonBone(width: 16, height: 16)
                skeletonBone(width: 120, height: 14)
            }
            skeletonBone(height: 12)
            skeletonBone(width: 80, height: 12)
        }
    }

    private func skeletonBone(width: CGFloat? = nil, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: VRadius.sm)
            .fill(VColor.surfaceOverlay)
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }
}
