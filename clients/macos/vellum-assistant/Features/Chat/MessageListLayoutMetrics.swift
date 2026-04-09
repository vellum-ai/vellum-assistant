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
        // Use the container width directly when valid. When unknown (0 or
        // non-finite), fall back to 0 instead of chatColumnMaxWidth to avoid
        // rendering 808pt-wide content inside a narrow container (e.g. the
        // chat dock). The content becomes visible once onGeometryChange
        // supplies the true width on the next layout pass.
        let scrollSurfaceWidth =
            (containerWidth.isFinite && containerWidth > 0)
            ? containerWidth
            : 0
        let chatColumnWidth = min(scrollSurfaceWidth, VSpacing.chatColumnMaxWidth)

        self.scrollSurfaceWidth = scrollSurfaceWidth
        self.chatColumnWidth = chatColumnWidth
        self.bubbleMaxWidth = min(
            VSpacing.chatBubbleMaxWidth,
            max(chatColumnWidth - 2 * VSpacing.xl, 0)
        )
    }
}
