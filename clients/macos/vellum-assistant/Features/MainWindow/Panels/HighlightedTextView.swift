import SwiftUI
import VellumAssistantShared

/// A code viewer with line numbers, horizontal scrolling, and syntax highlighting.
///
/// Uses pure SwiftUI rendering (TextEditor for editable mode, Text for read-only)
/// to avoid NSTextView compositing issues inside SwiftUI view hierarchies.
struct HighlightedTextView: View {
    @Binding var text: String
    let language: SyntaxLanguage
    let isEditable: Bool
    var onTextChange: ((String) -> Void)?

    private static let editorBackground = adaptiveColor(
        light: Color(.sRGB, red: 0.98, green: 0.98, blue: 0.97),
        dark: Color(.sRGB, red: 0.13, green: 0.14, blue: 0.13)
    )

    private static let gutterBackground = adaptiveColor(
        light: Color(.sRGB, red: 0.94, green: 0.94, blue: 0.94),
        dark: Color(.sRGB, red: 0.12, green: 0.12, blue: 0.12)
    )

    private static let gutterTextColor = adaptiveColor(
        light: Color(.sRGB, red: 0.55, green: 0.55, blue: 0.55),
        dark: Color(.sRGB, red: 0.45, green: 0.45, blue: 0.45)
    )

    var body: some View {
        if isEditable {
            editableView
        } else {
            readOnlyView
        }
    }

    // MARK: - Editable Mode

    /// TextEditor-based editable view — no line numbers but text is visible and editable.
    private var editableView: some View {
        TextEditor(text: editableBinding)
            .font(VFont.mono)
            .foregroundStyle(VColor.contentDefault)
            .scrollContentBackground(.hidden)
            .background(Self.editorBackground)
            .scrollDisabled(false)
    }

    private var editableBinding: Binding<String> {
        Binding(
            get: { text },
            set: { newValue in
                text = newValue
                onTextChange?(newValue)
            }
        )
    }

    // MARK: - Read-Only Mode

    /// Read-only view with line numbers and horizontal scrolling.
    private var readOnlyView: some View {
        let lines = text.components(separatedBy: "\n")
        let lineCount = lines.count
        let gutterWidth = gutterWidth(for: lineCount)

        return GeometryReader { geometry in
            ScrollView([.vertical]) {
                HStack(alignment: .top, spacing: 0) {
                    // Line number gutter — scrolls vertically, pinned horizontally
                    lineNumberGutter(lineCount: lineCount, width: gutterWidth)

                    // Text content — scrolls both directions
                    ScrollView(.horizontal, showsIndicators: true) {
                        Text(text)
                            .font(VFont.mono)
                            .foregroundStyle(VColor.contentDefault)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: true, vertical: false)
                            .padding(.vertical, VSpacing.sm)
                            .padding(.horizontal, VSpacing.md)
                    }
                    .frame(minWidth: geometry.size.width - gutterWidth)
                }
                .frame(minHeight: geometry.size.height, alignment: .topLeading)
            }
            .background(Self.editorBackground)
        }
    }

    // MARK: - Line Numbers

    private func lineNumberGutter(lineCount: Int, width: CGFloat) -> some View {
        VStack(alignment: .trailing, spacing: 0) {
            ForEach(1...max(1, lineCount), id: \.self) { num in
                Text("\(num)")
                    .font(VFont.monoSmall)
                    .foregroundStyle(Self.gutterTextColor)
                    .frame(height: lineHeight)
            }
        }
        .padding(.top, VSpacing.sm)
        .padding(.trailing, VSpacing.sm)
        .padding(.leading, VSpacing.sm)
        .frame(width: width, alignment: .trailing)
        .background(Self.gutterBackground)
    }

    /// Approximate line height for the mono font to align line numbers with text lines.
    private var lineHeight: CGFloat {
        // DMMono-Regular at 13pt has ~16pt line height in SwiftUI's default rendering
        16
    }

    private func gutterWidth(for lineCount: Int) -> CGFloat {
        let digitCount = max(3, "\(lineCount)".count)
        return CGFloat(digitCount * 8 + 16)
    }
}
