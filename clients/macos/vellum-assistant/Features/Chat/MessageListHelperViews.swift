import os.signpost
import SwiftUI
import VellumAssistantShared

// MARK: - ScrollToLatestOverlayView

/// Isolated child view for the "Scroll to latest" CTA. Creates its own
/// observation boundary so changes to `showScrollToLatest` only invalidate
/// this view — not the parent `MessageListView.body` or `ForEach`.
struct ScrollToLatestOverlayView: View {
    let scrollState: MessageListScrollState
    var onScrollToBottom: () -> Void = {}

    var body: some View {
        if scrollState.showScrollToLatest {
            Button(action: {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollToLatestPressed")
                // Spring animation drives both the CTA exit transition
                // and the scroll-to-bottom. The parent provides the scroll
                // action via onScrollToBottom, which repositions ScrollPosition.
                // Wrapping in an animation transaction ensures the .move/.opacity
                // transition runs in sync with the scroll.
                withAnimation(VAnimation.spring) {
                    onScrollToBottom()
                }
            }) {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.arrowDown, size: 10)
                    Text("Scroll to latest")
                        .font(VFont.bodySmallDefault)
                }
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
                .background(VColor.surfaceOverlay)
                .clipShape(Capsule())
                .shadow(color: VColor.auxBlack.opacity(0.15), radius: 4, y: 2)
            }
            .buttonStyle(.plain)
            .background { ScrollWheelPassthrough() }
            .padding(.bottom, VSpacing.lg)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}
