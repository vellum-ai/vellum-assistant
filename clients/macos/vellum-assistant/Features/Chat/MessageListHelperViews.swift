import os.signpost
import SwiftUI
import VellumAssistantShared

// MARK: - ScrollToLatestOverlayView

/// Isolated child view for the "Scroll to latest" CTA. Shown when the
/// viewport is not at the bottom of the content.
struct ScrollToLatestOverlayView: View {
    let isAtBottom: Bool
    let onScrollToLatest: () -> Void

    var body: some View {
        if !isAtBottom {
            Button(action: {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollToLatestPressed")
                onScrollToLatest()
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
