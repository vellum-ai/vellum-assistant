import SwiftUI
import VellumAssistantShared

/// Blank page with a centered loading spinner, shown over the chat area
/// while waiting for the daemon to connect.
struct DaemonLoadingChatSkeleton: View {
    var body: some View {
        ZStack {
            VColor.backgroundSubtle
                .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
            VLoadingIndicator(size: 24, color: VColor.textMuted)
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
#Preview("DaemonLoadingChatSkeleton") {
    ZStack {
        VColor.background.ignoresSafeArea()
        DaemonLoadingChatSkeleton()
            .padding(VSpacing.lg)
    }
    .frame(width: 600, height: 500)
}

#Preview("DaemonLoadingThreadsSkeleton") {
    ZStack {
        VColor.backgroundSubtle.ignoresSafeArea()
        DaemonLoadingThreadsSkeleton()
    }
    .frame(width: 240, height: 300)
}
#endif
