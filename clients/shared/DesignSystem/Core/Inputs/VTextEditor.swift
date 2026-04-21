import SwiftUI

/// Multi-line free-form text input.
///
/// Backed by `TextEditor` so Return inserts a newline (matching the platform
/// convention for multi-line text areas). `TextEditor` has no native
/// placeholder, so we overlay a `Text` when the bound string is empty, aligned
/// to the text container's natural insets.
public struct VTextEditor: View {
    public let placeholder: String
    @Binding public var text: String
    public var minHeight: CGFloat = 80
    public var maxHeight: CGFloat = 200

    @FocusState private var isFocused: Bool

    public init(placeholder: String, text: Binding<String>, minHeight: CGFloat = 80, maxHeight: CGFloat = 200) {
        self.placeholder = placeholder
        self._text = text
        self.minHeight = minHeight
        self.maxHeight = maxHeight
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $text)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .scrollContentBackground(.hidden)
                .background(Color.clear)
                .focused($isFocused)
                .accessibilityLabel(placeholder)

            if text.isEmpty {
                Text(placeholder)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentTertiary)
                    // Compensate for the underlying NSTextView's default text-container
                    // insets (~5pt line fragment padding horizontally, ~8pt vertically)
                    // so the placeholder sits directly behind the caret.
                    .padding(.horizontal, 5)
                    .padding(.vertical, 8)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: minHeight, maxHeight: maxHeight, alignment: .topLeading)
        .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.md, bottom: VSpacing.sm, trailing: VSpacing.md))
        .contentShape(Rectangle())
        .simultaneousGesture(TapGesture().onEnded { isFocused = true })
        .vInputChrome(isFocused: isFocused)
    }
}
