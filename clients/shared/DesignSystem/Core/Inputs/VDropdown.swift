import SwiftUI

/// A generic dropdown that looks pixel-identical to VTextField with a trailing chevron.
///
/// Uses a `Menu` containing an inline `Picker` for proper selection semantics
/// (automatic checkmarks, accessibility). The visual label is fully custom.
/// Defaults to filling available width; callers can pass a custom `maxWidth` to constrain.
public struct VDropdown<T: Hashable>: View {
    public let placeholder: String
    @Binding public var selection: T
    public let options: [(label: String, value: T)]
    /// Optional label displayed above the dropdown.
    public var label: String? = nil
    /// When selection equals emptyValue, placeholder text is shown instead.
    public var emptyValue: T? = nil
    /// Size variant controlling height, font, padding, and corner radius.
    public var size: VInputSize = .regular
    /// The maximum width of the dropdown. Defaults to .infinity (fills available width).
    public var maxWidth: CGFloat = .infinity
    /// Optional leading icon displayed before the label text.
    public var icon: VIcon? = nil
    /// Optional closure that returns an icon for each option value, shown in the menu.
    public var optionIcon: ((T) -> VIcon?)? = nil
    /// Optional error message displayed below the dropdown.
    public var errorMessage: String? = nil

    @Environment(\.isEnabled) private var isEnabled

    public init(
        _ label: String? = nil,
        placeholder: String,
        selection: Binding<T>,
        options: [(label: String, value: T)],
        emptyValue: T? = nil,
        size: VInputSize = .regular,
        maxWidth: CGFloat = .infinity,
        icon: VIcon? = nil,
        optionIcon: ((T) -> VIcon?)? = nil,
        errorMessage: String? = nil
    ) {
        self.label = label
        self.placeholder = placeholder
        self._selection = selection
        self.options = options
        self.emptyValue = emptyValue
        self.size = size
        self.maxWidth = maxWidth
        self.icon = icon
        self.optionIcon = optionIcon
        self.errorMessage = errorMessage
    }

    private var selectedLabel: String? {
        if let emptyValue = emptyValue, selection == emptyValue {
            return nil
        }
        return options.first(where: { $0.value == selection })?.label
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if let label {
                Text(label)
                    .font(VFont.inputLabel)
                    .foregroundColor(isEnabled ? VColor.contentSecondary : VColor.contentDisabled)
                    .accessibilityHidden(true)
            }

            Menu {
                Picker("", selection: $selection) {
                    ForEach(options, id: \.value) { option in
                        if let optionIcon, let icon = optionIcon(option.value) {
                            Label {
                                Text(option.label)
                            } icon: {
                                icon.image(size: 14)
                            }
                            .tag(option.value)
                        } else {
                            Text(option.label).tag(option.value)
                        }
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } label: {
                HStack(spacing: size.horizontalPadding) {
                    HStack(spacing: size == .small ? VSpacing.xs : VSpacing.sm) {
                        if let resolvedIcon = icon ?? optionIcon?(selection) {
                            VIconView(resolvedIcon, size: size.iconSize)
                                .foregroundColor(VColor.contentTertiary)
                        }

                        Group {
                            if let selectedLabel {
                                Text(selectedLabel)
                                    .foregroundColor(VColor.contentDefault)
                            } else {
                                Text(placeholder)
                                    .foregroundColor(VColor.contentTertiary)
                            }
                        }
                        .font(size.font)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    VIconView(.chevronDown, size: size.iconSize)
                        .foregroundColor(VColor.contentTertiary)
                        .accessibilityHidden(true)
                }
                .padding(.horizontal, size.horizontalPadding)
                .padding(.vertical, size.verticalPadding)
                .frame(maxWidth: .infinity)
                .frame(height: size.height)
                .vInputChrome(isError: errorMessage != nil, isDisabled: !isEnabled, cornerRadius: size.cornerRadius)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .accessibilityLabel(label ?? placeholder)
            .accessibilityValue(selectedLabel ?? "")
            .accessibilityHint(errorMessage ?? "")

            if let errorMessage {
                Text(errorMessage)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
                    .accessibilityHidden(true)
            }
        }
        .frame(maxWidth: maxWidth)
    }
}
