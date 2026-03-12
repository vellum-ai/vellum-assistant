import SwiftUI

/// A ViewModifier that applies the design system input styling.
/// Strips the native macOS text field background and applies VColor.surfaceActive.
/// Use on raw TextField / SecureField instances: `.vInputStyle()`
public struct VInputStyleModifier: ViewModifier {
    public init() {}

    public func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.xs)
            .frame(height: 28)
            .background(VColor.surfaceActive)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.borderBase, lineWidth: 1)
            )
    }
}

extension View {
    public func vInputStyle() -> some View {
        modifier(VInputStyleModifier())
    }
}

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
                VIconView(.resolve(leadingIcon), size: 13)
                    .foregroundColor(VColor.contentTertiary)
                    .accessibilityHidden(true)
            }

            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .focused($isFocused)
                .onSubmit {
                    onSubmit?()
                }

            if let trailingIcon = trailingIcon {
                VIconView(.resolve(trailingIcon), size: 13)
                    .foregroundColor(VColor.contentTertiary)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .frame(height: 28)
        .background(VColor.surfaceActive)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(isFocused ? VColor.borderBase : VColor.borderBase.opacity(0.5), lineWidth: 1)
        )
    }
}

#if DEBUG

private struct VTextFieldPreviewWrapper: View {
    @State private var text = ""

    var body: some View {
        ZStack {
            VColor.surfaceOverlay.ignoresSafeArea()
            VStack(spacing: 16) {
                VTextField(placeholder: "Plain text field", text: $text)
                VTextField(placeholder: "With leading icon", text: $text, leadingIcon: VIcon.search.rawValue)
                VTextField(placeholder: "With trailing icon", text: $text, trailingIcon: VIcon.mail.rawValue)
                VTextField(placeholder: "Both icons", text: $text, leadingIcon: VIcon.search.rawValue, trailingIcon: VIcon.circleX.rawValue)
            }
            .padding()
        }
    }
}
#endif
