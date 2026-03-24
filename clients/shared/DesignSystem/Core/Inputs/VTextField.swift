import SwiftUI

/// Size variants for input components (VTextField, VDropdown).
public enum VInputSize {
    case regular
    case small

    var height: CGFloat {
        switch self {
        case .regular: return 32
        case .small: return 28
        }
    }

    var font: Font {
        switch self {
        case .regular: return VFont.bodyMediumLighter
        case .small: return VFont.labelDefault
        }
    }

    var iconSize: CGFloat {
        switch self {
        case .regular: return 13
        case .small: return 12
        }
    }

    var horizontalPadding: CGFloat {
        switch self {
        case .regular: return VSpacing.md
        case .small: return VSpacing.sm
        }
    }

    var verticalPadding: CGFloat {
        switch self {
        case .regular: return VSpacing.xs
        case .small: return VSpacing.xs
        }
    }

    var cornerRadius: CGFloat {
        switch self {
        case .regular: return VRadius.md
        case .small: return VRadius.sm
        }
    }
}

extension View {
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
///
/// ## Focus handling
/// VTextField owns an internal `@FocusState` that drives its chrome styling
/// (border highlight, shadow). Callers that need programmatic focus control
/// should pass a `FocusState<Bool>.Binding` via the `isFocused` parameter —
/// this binding is applied **directly** to the inner `TextField`/`SecureField`
/// so there is exactly one focus binding per focusable view, matching Apple's
/// recommended pattern.
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
    public var font: Font = VFont.bodyMediumLighter
    public var size: VInputSize = .regular

    /// Internal focus state — used only when the caller does NOT provide
    /// an external `FocusState<Bool>.Binding`.
    @FocusState private var internalFocus: Bool

    /// External focus binding provided by the caller. When non-nil this is
    /// applied to the inner field instead of `internalFocus`.
    private var externalFocus: FocusState<Bool>.Binding?

    @Environment(\.isEnabled) private var isEnabled

    /// Whether the inner field is currently focused. Reads from whichever
    /// focus source is active (external binding or internal state).
    private var isFocused: Bool {
        externalFocus?.wrappedValue ?? internalFocus
    }

    // MARK: - Initializers

    /// Standard initializer — VTextField manages its own focus internally.
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
        font: Font? = nil,
        size: VInputSize = .regular
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
        self.size = size
        self.font = font ?? size.font
        self.externalFocus = nil
    }

    /// Initializer with external focus control. The caller's
    /// `FocusState<Bool>.Binding` is wired directly to the inner field —
    /// no competing bindings, no onChange sync.
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
        font: Font? = nil,
        size: VInputSize = .regular,
        isFocused: FocusState<Bool>.Binding
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
        self.size = size
        self.font = font ?? size.font
        self.externalFocus = isFocused
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if let label {
                Text(label)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(isEnabled ? VColor.contentSecondary : VColor.contentDisabled)
                    .accessibilityHidden(true)
            }

            HStack(spacing: size.horizontalPadding) {
                if let leadingIcon {
                    VIconView(.resolve(leadingIcon), size: size.iconSize)
                        .foregroundStyle(VColor.contentTertiary)
                        .accessibilityHidden(true)
                }

                inputField

                if let trailingIcon {
                    VIconView(.resolve(trailingIcon), size: size.iconSize)
                        .foregroundStyle(VColor.contentTertiary)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, size.horizontalPadding)
            .padding(.vertical, size.verticalPadding)
            .frame(height: size.height)
            .vInputChrome(isFocused: isFocused, isError: errorMessage != nil, isDisabled: !isEnabled, cornerRadius: size.cornerRadius)

            if let errorMessage {
                Text(errorMessage)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
                    .accessibilityHidden(true)
            }
        }
        .frame(maxWidth: maxWidth)
    }

    @ViewBuilder
    private var inputField: some View {
        let field = Group {
            if isSecure {
                SecureField(placeholder, text: $text)
                    .textFieldStyle(.plain)
                    .font(font)
                    .foregroundStyle(VColor.contentDefault)
                    .onSubmit { onSubmit?() }
            } else {
                TextField(placeholder, text: $text)
                    .textFieldStyle(.plain)
                    .font(font)
                    .foregroundStyle(VColor.contentDefault)
                    .onSubmit { onSubmit?() }
            }
        }

        // Apply exactly one .focused() binding to the inner field.
        // When the caller provides an external FocusState binding, use it
        // directly so focus reads/writes go through a single source of truth.
        if let externalFocus {
            field
                .focused(externalFocus)
                .accessibilityLabel(label ?? placeholder)
                .accessibilityHint(errorMessage ?? "")
        } else {
            field
                .focused($internalFocus)
                .accessibilityLabel(label ?? placeholder)
                .accessibilityHint(errorMessage ?? "")
        }
    }
}
