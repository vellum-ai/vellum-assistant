import os.signpost
import SwiftUI
import VellumAssistantShared

// MARK: - TailSpacerView

/// Isolated child view for the push-to-top tail spacer. Creates its own
/// observation boundary so changes to `showTailSpacer` only invalidate this
/// view — not the parent `LazyVStack` or `ForEach`.
///
/// Reference: [WWDC23 — Discover Observation in SwiftUI](https://developer.apple.com/videos/play/wwdc2023/10149/)
struct TailSpacerView: View {
    let scrollState: MessageListScrollState

    var body: some View {
        if scrollState.showTailSpacer {
            Color.clear
                .frame(height: scrollState.tailSpacerHeight)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
                .onAppear {
                    scrollState.consumePendingPushToTop()
                }
        }
    }
}

// MARK: - ScrollToLatestOverlayView

/// Isolated child view for the "Scroll to latest" CTA. Creates its own
/// observation boundary so changes to `showScrollToLatest` only invalidate
/// this view — not the parent `MessageListView.body` or `ForEach`.
struct ScrollToLatestOverlayView: View {
    let scrollState: MessageListScrollState

    var body: some View {
        if scrollState.showScrollToLatest {
            Button(action: {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollToLatestPressed")
                scrollState.requestPinToBottom(animated: true, userInitiated: true)
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
