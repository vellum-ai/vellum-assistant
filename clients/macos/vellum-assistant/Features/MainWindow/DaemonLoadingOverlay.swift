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

/// Full-screen overlay shown when the daemon connection fails during
/// first-launch bootstrap (e.g. remote assistant unreachable after timeout).
/// Provides a retry button so the user can attempt reconnection.
struct DaemonConnectionFailedView: View {
    let onRetry: () -> Void

    var body: some View {
        ZStack {
            VColor.surfaceBase
                .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))

            VStack(spacing: VSpacing.lg) {
                Spacer()

                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 40))
                    .foregroundColor(VColor.systemNegativeStrong)
                    .padding(.bottom, VSpacing.sm)

                Text("Something went wrong")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.contentDefault)

                Text("Could not connect to your assistant.")
                    .font(.system(size: 14))
                    .foregroundColor(VColor.contentSecondary)

                VButton(label: "Try Again", style: .primary) {
                    onRetry()
                }
                .frame(maxWidth: 200)
                .padding(.top, VSpacing.sm)

                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

#if DEBUG

#endif
