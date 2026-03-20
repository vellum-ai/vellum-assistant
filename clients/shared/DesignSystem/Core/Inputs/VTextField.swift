import SwiftUI

/// A ViewModifier that applies the shared input chrome across text inputs.
/// Use on raw TextField / SecureField instances: `.vInputStyle()`
public struct VInputStyleModifier: ViewModifier {
    public var maxWidth: CGFloat = .infinity

    public init(maxWidth: CGFloat = .infinity) {
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
    public func vInputStyle(maxWidth: CGFloat = .infinity) -> some View {
        modifier(VInputStyleModifier(maxWidth: maxWidth))
    }

    public func vInputChrome(isFocused: Bool = false, isError: Bool = false, isDisabled: Bool = false, cornerRadius: CGFloat = VRadius.md) -> some View {
        modifier(VInputChromeModifier(isFocused: isFocused, isError: isError, isDisabled: isDisabled, cornerRadius: cornerRadius))
    }
}

public struct VInputChromeModifier: ViewModifier {
    public let isFocused: Bool
    public let isError: Bool
    public let isDisabled: Bool
    public let cornerRadius: CGFloat

    public init(isFocused: Bool = false, isError: Bool = false, isDisabled: Bool = false, cornerRadius: CGFloat = VRadius.md) {
        self.isFocused = isFocused
        self.isError = isError
        self.isDisabled = isDisabled
        self.cornerRadius = cornerRadius
    }

    public func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius)

        content
            .background(shape.fill(isDisabled ? VColor.surfaceOverlay : VColor.surfaceBase))
            .overlay(
                shape.strokeBorder(
                    borderColor,
                    lineWidth: (isFocused || isError) ? 1.5 : 1
                )
            )
            .clipShape(shape)
            .shadow(
                color: isFocused && !isError ? VColor.primaryBase.opacity(0.10) : .clear,
                radius: 4
            )
            .opacity(isDisabled ? 0.6 : 1.0)
    }

    private var borderColor: Color {
        if isError {
            return VColor.systemNegativeStrong
        }
        if isFocused {
            return VColor.borderActive
        }
        return VColor.borderBase.opacity(0.72)
    }
}

/// Single-line text input with optional label, icons, secure mode, and error display.
public struct VTextField: View {
    public let placeholder: String
    @Binding public var text: String
    public var label: String? = nil
    public var leadingIcon: String? = nil
    public var trailingIcon: String? = nil
    public var isSecure: Bool = false
    public var errorMessage: String? = nil
    public var onSubmit: (() -> Void)? = nil
    public var maxWidth: CGFloat = .infinity
    /// Optional external focus binding. When provided, setting this to `true`
    /// programmatically focuses the field; the binding also reflects focus changes
    /// initiated by the user (e.g. clicking into the field).
    private var externalFocus: Binding<Bool>?

    @FocusState private var isFocused: Bool
    @Environment(\.isEnabled) private var isEnabled

    public init(
        _ label: String? = nil,
        placeholder: String,
        text: Binding<String>,
        leadingIcon: String? = nil,
        trailingIcon: String? = nil,
        isSecure: Bool = false,
        errorMessage: String? = nil,
        onSubmit: (() -> Void)? = nil,
        maxWidth: CGFloat = .infinity,
        isFocused: Binding<Bool>? = nil
    ) {
        self.label = label
        self.placeholder = placeholder
        self._text = text
        self.leadingIcon = leadingIcon
        self.trailingIcon = trailingIcon
        self.isSecure = isSecure
        self.errorMessage = errorMessage
        self.onSubmit = onSubmit
        self.maxWidth = maxWidth
        self.externalFocus = isFocused
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if let label {
                Text(label)
                    .font(VFont.inputLabel)
                    .foregroundColor(isEnabled ? VColor.contentSecondary : VColor.contentDisabled)
                    .accessibilityHidden(true)
            }

            HStack(spacing: VSpacing.md) {
                if let leadingIcon {
                    VIconView(.resolve(leadingIcon), size: 13)
                        .foregroundColor(VColor.contentTertiary)
                        .accessibilityHidden(true)
                }

                inputField

                if let trailingIcon {
                    VIconView(.resolve(trailingIcon), size: 13)
                        .foregroundColor(VColor.contentTertiary)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.xs)
            .frame(height: 32)
            .vInputChrome(isFocused: isFocused, isError: errorMessage != nil, isDisabled: !isEnabled)

            if let errorMessage {
                Text(errorMessage)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
                    .accessibilityHidden(true)
            }
        }
        .frame(maxWidth: maxWidth)
        .onChange(of: isFocused) { _, newValue in
            if externalFocus?.wrappedValue != newValue {
                externalFocus?.wrappedValue = newValue
            }
        }
        .onChange(of: externalFocus?.wrappedValue) { _, newValue in
            if let newValue, isFocused != newValue {
                isFocused = newValue
            }
        }
    }

    @ViewBuilder
    private var inputField: some View {
        let field = Group {
            if isSecure {
                SecureField(placeholder, text: $text)
                    .textFieldStyle(.plain)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                    .focused($isFocused)
                    .onSubmit { onSubmit?() }
            } else {
                TextField(placeholder, text: $text)
                    .textFieldStyle(.plain)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                    .focused($isFocused)
                    .onSubmit { onSubmit?() }
            }
        }

        field
            .accessibilityLabel(label ?? placeholder)
            .accessibilityHint(errorMessage ?? "")
    }
}
