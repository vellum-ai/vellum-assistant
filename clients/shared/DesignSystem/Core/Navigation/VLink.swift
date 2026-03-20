import SwiftUI

/// A styled external link that opens a URL in the default browser.
///
/// Wraps SwiftUI's `Link` with design system defaults: pointer cursor on macOS,
/// single-line truncation, and `VFont.caption` sizing. Use the `font` parameter
/// to override when a different text size is needed (e.g., `VFont.body`).
///
/// ```swift
/// VLink("@botname", destination: telegramURL, font: VFont.body)
/// VLink(slackUserId, destination: slackDeepLink)
/// ```
public struct VLink: View {
    private let text: String
    private let destination: URL
    private let font: Font

    public init(_ text: String, destination: URL, font: Font = VFont.caption) {
        self.text = text
        self.destination = destination
        self.font = font
    }

    public var body: some View {
        Link(text, destination: destination)
            .font(font)
            .lineLimit(1)
            .pointerCursor()
    }
}
