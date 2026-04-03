import SwiftUI

/// A styled external link that opens a URL in the default browser.
///
/// Wraps SwiftUI's `Link` with design system defaults: pointer cursor on macOS,
/// single-line truncation, and `VFont.labelDefault` sizing. Use the `font` parameter
/// to override when a different text size is needed (e.g., `VFont.bodyMediumLighter`).
///
/// ```swift
/// VLink("@botname", destination: telegramURL, font: VFont.bodyMediumLighter)
/// VLink(slackUserId, destination: slackDeepLink)
/// VLink("Terms of Service", destination: tosURL, underline: true)
/// ```
public struct VLink: View {
    private let text: String
    private let destination: URL
    private let font: Font
    private let underline: Bool

    public init(_ text: String, destination: URL, font: Font = VFont.labelDefault, underline: Bool = false) {
        self.text = text
        self.destination = destination
        self.font = font
        self.underline = underline
    }

    public var body: some View {
        Link(destination: destination) {
            Text(text)
                .underline(underline)
        }
        .font(font)
        .lineLimit(1)
        .pointerCursor()
    }
}
