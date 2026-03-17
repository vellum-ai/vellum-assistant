import SwiftUI
import VellumAssistantShared

/// A single capability card in the feed, showing an icon, title, description, and tag pills.
struct CapabilityCardView: View {
    let card: CapabilityCard
    let onTap: () -> Void

    @State private var isHovered = false

    private var resolvedIcon: VIcon {
        VIcon.resolve(card.icon ?? "lucide-sparkles")
    }

    var body: some View {
        Button(action: onTap) {
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
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)
                }

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
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(VSpacing.lg)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isHovered ? VColor.surfaceOverlay : VColor.surfaceActive)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.borderBase, lineWidth: 0.5)
            )
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
}

/// Skeleton placeholder for a card that is still being generated.
struct CapabilityCardSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                VSkeletonBone()
                    .frame(width: 16, height: 16)

                VSkeletonBone()
                    .frame(width: 120, height: 14)
            }

            VSkeletonBone()
                .frame(height: 12)

            VSkeletonBone()
                .frame(width: 80, height: 12)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceActive)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.borderBase.opacity(0.3), lineWidth: 0.5)
        )
    }
}
