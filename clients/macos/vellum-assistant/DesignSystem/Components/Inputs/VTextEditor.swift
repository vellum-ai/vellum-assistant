import SwiftUI

struct VTextEditor: View {
    let placeholder: String
    @Binding var text: String
    var minHeight: CGFloat = 80
    var maxHeight: CGFloat = 200

    @FocusState private var isFocused: Bool

    var body: some View {
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
