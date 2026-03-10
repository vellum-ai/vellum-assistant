import SwiftUI
import VellumAssistantShared

/// Skeleton placeholder for the chat area while a thread is loading.
/// Shows alternating assistant/user message bones that mimic the real
/// `ChatBubble` layout, replacing a generic spinner with a content-aware preview.
struct ChatLoadingSkeleton: View {
    /// Defines a skeleton row: either an assistant or user message placeholder.
    private struct SkeletonRow: Identifiable {
        let id: Int
        let isUser: Bool
        /// Fraction of `chatBubbleMaxWidth` the main bone should occupy.
        let widthFraction: CGFloat
        /// Height of the main text bone.
        let boneHeight: CGFloat
    }

    private let rows: [SkeletonRow] = [
        SkeletonRow(id: 0, isUser: false, widthFraction: 0.75, boneHeight: 48),
        SkeletonRow(id: 1, isUser: true,  widthFraction: 0.40, boneHeight: 20),
        SkeletonRow(id: 2, isUser: false, widthFraction: 0.60, boneHeight: 32),
        SkeletonRow(id: 3, isUser: true,  widthFraction: 0.35, boneHeight: 20),
    ]

    /// Avatar reserve: 28pt circle + 8pt gap.
    private let avatarReserve: CGFloat = 28 + VSpacing.sm

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            ForEach(rows) { row in
                if row.isUser {
                    userRow(row)
                } else {
                    assistantRow(row)
                }
            }
        }
        .accessibilityHidden(true)
    }

    // MARK: - Assistant Row

    @ViewBuilder
    private func assistantRow(_ row: SkeletonRow) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            // Avatar placeholder
            VSkeletonBone(width: 28, height: 28, radius: 14)

            // Text bone
            VSkeletonBone(height: row.boneHeight, radius: VRadius.lg)
                .frame(width: VSpacing.chatBubbleMaxWidth * row.widthFraction)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - User Row

    @ViewBuilder
    private func userRow(_ row: SkeletonRow) -> some View {
        VSkeletonBone(height: row.boneHeight, radius: VRadius.lg)
            .frame(width: VSpacing.chatBubbleMaxWidth * row.widthFraction)
            .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

#Preview("ChatLoadingSkeleton") {
    ZStack {
        VColor.background.ignoresSafeArea()
        ChatLoadingSkeleton()
            .padding(VSpacing.lg)
    }
    .frame(width: 700, height: 400)
}
