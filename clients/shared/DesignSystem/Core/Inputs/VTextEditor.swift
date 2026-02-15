import SwiftUI

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
            if text.isEmpty {
                Text(placeholder)
                    .font(VFont.body)
                    .foregroundColor(VColor.textMuted)
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.md)
                    .accessibilityHidden(true)
            }

            TextEditor(text: $text)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .scrollContentBackground(.hidden)
                .focused($isFocused)
                .frame(minHeight: minHeight, maxHeight: maxHeight)
                .accessibilityLabel(text.isEmpty ? placeholder : text)
        }
        .padding(VSpacing.xs)
        .background(VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(isFocused ? VColor.surfaceBorder : VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
        )
    }
}

#if DEBUG
struct VTextEditor_Preview: PreviewProvider {
    static var previews: some View {
        VTextEditorPreviewWrapper()
            .frame(width: 400, height: 350)
            .previewDisplayName("VTextEditor")
    }
}

private struct VTextEditorPreviewWrapper: View {
    @State private var text = ""

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            VStack(spacing: 16) {
                VTextEditor(placeholder: "Write something...", text: $text)
                VTextEditor(placeholder: "Short editor", text: $text, minHeight: 40, maxHeight: 80)
            }
            .padding()
        }
    }
}
#endif
