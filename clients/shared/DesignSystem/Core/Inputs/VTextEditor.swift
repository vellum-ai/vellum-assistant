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
            .background(VColor.surfaceActive)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(isFocused ? VColor.borderBase : VColor.borderBase.opacity(0.5), lineWidth: 1)
            )
    }
}

#if DEBUG

private struct VTextEditorPreviewWrapper: View {
    @State private var text = ""

    var body: some View {
        ZStack {
            VColor.surfaceOverlay.ignoresSafeArea()
            VStack(spacing: 16) {
                VTextEditor(placeholder: "Write something...", text: $text)
                VTextEditor(placeholder: "Short editor", text: $text, minHeight: 40, maxHeight: 80)
            }
            .padding()
        }
    }
}
#endif
