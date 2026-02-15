import SwiftUI

public struct VTextField: View {
    public let placeholder: String
    @Binding public var text: String
    public var leadingIcon: String? = nil
    public var trailingIcon: String? = nil
    public var onSubmit: (() -> Void)? = nil

    @FocusState private var isFocused: Bool

    public init(placeholder: String, text: Binding<String>, leadingIcon: String? = nil, trailingIcon: String? = nil, onSubmit: (() -> Void)? = nil) {
        self.placeholder = placeholder
        self._text = text
        self.leadingIcon = leadingIcon
        self.trailingIcon = trailingIcon
        self.onSubmit = onSubmit
    }

    public var body: some View {
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

#if DEBUG
struct VTextField_Preview: PreviewProvider {
    static var previews: some View {
        VTextFieldPreviewWrapper()
            .frame(width: 350, height: 280)
            .previewDisplayName("VTextField")
    }
}

private struct VTextFieldPreviewWrapper: View {
    @State private var text = ""

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            VStack(spacing: 16) {
                VTextField(placeholder: "Plain text field", text: $text)
                VTextField(placeholder: "With leading icon", text: $text, leadingIcon: "magnifyingglass")
                VTextField(placeholder: "With trailing icon", text: $text, trailingIcon: "envelope")
                VTextField(placeholder: "Both icons", text: $text, leadingIcon: "magnifyingglass", trailingIcon: "xmark.circle")
            }
            .padding()
        }
    }
}
#endif
