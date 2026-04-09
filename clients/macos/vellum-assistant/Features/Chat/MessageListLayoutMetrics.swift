import CoreGraphics
import VellumAssistantShared

/// Shared width calculations for the chat transcript.
///
/// The transcript scroll surface spans the full available pane width so wheel
/// input works in the gutters, while the rendered chat column stays centered
/// and capped to the existing max width.
struct MessageListLayoutMetrics: Equatable {
    let scrollSurfaceWidth: CGFloat
    let chatColumnWidth: CGFloat
    let bubbleMaxWidth: CGFloat

    init(containerWidth: CGFloat) {
        let scrollSurfaceWidth =
            (containerWidth.isFinite && containerWidth > 0)
            ? containerWidth
            : VSpacing.chatColumnMaxWidth
        let chatColumnWidth = min(scrollSurfaceWidth, VSpacing.chatColumnMaxWidth)

        self.scrollSurfaceWidth = scrollSurfaceWidth
        self.chatColumnWidth = chatColumnWidth
        self.bubbleMaxWidth = min(
            VSpacing.chatBubbleMaxWidth,
            max(chatColumnWidth - 2 * VSpacing.xl, 0)
        )
    }
}
