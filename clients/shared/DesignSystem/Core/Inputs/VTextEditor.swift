import SwiftUI

/// Multi-line text input with native placeholder support.
/// Uses `TextField(axis: .vertical)` so the placeholder, typed text,
/// and caret all share the same text container and align correctly.
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
        TextField(placeholder, text: $text, axis: .vertical)
            .lineLimit(1...100)
            .textFieldStyle(.plain)
            .font(VFont.body)
            .foregroundColor(VColor.contentDefault)
            .focused($isFocused)
            .frame(minHeight: minHeight, maxHeight: maxHeight, alignment: .topLeading)
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .vInputChrome(isFocused: isFocused)
    }
}
