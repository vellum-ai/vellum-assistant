import SwiftUI

/// A ViewModifier that applies the shared input chrome across text inputs.
/// Use on raw TextField / SecureField instances: `.vInputStyle()`
public struct VInputStyleModifier: ViewModifier {
    public var maxWidth: CGFloat = 400

    public init(maxWidth: CGFloat = 400) {
        self.maxWidth = maxWidth
    }

    public func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.xs)
            .frame(height: 32)
            .vInputChrome()
            .frame(maxWidth: maxWidth)
    }
}

extension View {
    public func vInputStyle(maxWidth: CGFloat = 400) -> some View {
        modifier(VInputStyleModifier(maxWidth: maxWidth))
    }

    public func vInputChrome(isFocused: Bool = false, cornerRadius: CGFloat = VRadius.md) -> some View {
        modifier(VInputChromeModifier(isFocused: isFocused, cornerRadius: cornerRadius))
    }
}

public struct VInputChromeModifier: ViewModifier {
    public let isFocused: Bool
    public let cornerRadius: CGFloat

    public init(isFocused: Bool = false, cornerRadius: CGFloat = VRadius.md) {
        self.isFocused = isFocused
        self.cornerRadius = cornerRadius
    }

    public func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius)

        content
            .background(shape.fill(VColor.surfaceBase))
            .overlay(
                shape.strokeBorder(
                    isFocused ? VColor.borderActive : VColor.borderBase.opacity(0.72),
                    lineWidth: isFocused ? 1.5 : 1
                )
            )
            .clipShape(shape)
            .shadow(
                color: isFocused ? VColor.primaryBase.opacity(0.10) : .clear,
                radius: 4
            )
    }
}

public struct VTextField: View {
    public let placeholder: String
    @Binding public var text: String
    public var leadingIcon: String? = nil
    public var trailingIcon: String? = nil
    public var onSubmit: (() -> Void)? = nil
    public var maxWidth: CGFloat = 400

    @FocusState private var isFocused: Bool

    public init(placeholder: String, text: Binding<String>, leadingIcon: String? = nil, trailingIcon: String? = nil, onSubmit: (() -> Void)? = nil, maxWidth: CGFloat = 400) {
        self.placeholder = placeholder
        self._text = text
        self.leadingIcon = leadingIcon
        self.trailingIcon = trailingIcon
        self.onSubmit = onSubmit
        self.maxWidth = maxWidth
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
        .frame(height: 32)
        .vInputChrome(isFocused: isFocused)
        .frame(maxWidth: maxWidth)
    }
}
