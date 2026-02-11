import SwiftUI

struct VTextField: View {
    let placeholder: String
    @Binding var text: String
    var leadingIcon: String? = nil
    var trailingIcon: String? = nil
    var onSubmit: (() -> Void)? = nil

    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: VSpacing.md) {
            if let leadingIcon = leadingIcon {
                Image(systemName: leadingIcon)
                    .foregroundColor(VColor.textMuted)
                    .font(.system(size: 14))
                    .accessibilityHidden(true)
            }

            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .focused($isFocused)
                .onSubmit {
                    onSubmit?()
                }

            if let trailingIcon = trailingIcon {
                Image(systemName: trailingIcon)
                    .foregroundColor(VColor.textMuted)
                    .font(.system(size: 14))
                    .accessibilityHidden(true)
            }
        }
        .padding(VSpacing.md)
        .background(VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(isFocused ? VColor.surfaceBorder : VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
        )
    }
}
