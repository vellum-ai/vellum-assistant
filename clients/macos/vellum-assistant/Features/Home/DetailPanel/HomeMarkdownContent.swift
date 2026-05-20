import SwiftUI
import VellumAssistantShared

/// Renders a markdown string as styled `Text` in the Home detail panel.
///
/// Uses SwiftUI's native `AttributedString(markdown:)` for inline formatting
/// (bold, italic, links, code). Falls back to plain text when the markdown
/// parse fails so the UI never blanks on malformed input.
struct HomeMarkdownContent: View {
    let text: String

    var body: some View {
        HStack {
            Text(rendered)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
    }

    /// Parses the source text as markdown into an `AttributedString`,
    /// falling back to a plain-text `AttributedString` on failure.
    private var rendered: AttributedString {
        if let attributed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            return attributed
        }
        return AttributedString(text)
    }
}
