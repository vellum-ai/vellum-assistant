import SwiftUI
import VellumAssistantShared

/// Skeleton placeholder shown over the chat area while waiting for the
/// daemon to connect.
struct DaemonLoadingChatSkeleton: View {
    var body: some View {
        ZStack {
            VColor.surfaceBase
                .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
            ChatLoadingSkeleton()
                .padding(VSpacing.lg)
        }
        .accessibilityHidden(true)
    }
}

/// Skeleton thread rows shown in the sidebar while threads are loading.
/// Mimics 5 thread rows matching the height of nav items like "Things".
struct DaemonLoadingThreadsSkeleton: View {
    var body: some View {
        VStack(spacing: SidebarLayoutMetrics.listRowGap) {
            ForEach(0..<5, id: \.self) { _ in
                VSkeletonBone(height: 13)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, VSpacing.xs)
                    .padding(.vertical, SidebarLayoutMetrics.rowVerticalPadding)
                    .frame(minHeight: SidebarLayoutMetrics.rowMinHeight)
                    .padding(.horizontal, VSpacing.sm)
            }
        }
        .accessibilityHidden(true)
    }
}

#if DEBUG

#endif
