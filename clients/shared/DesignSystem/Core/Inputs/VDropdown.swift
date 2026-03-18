import SwiftUI

/// A generic dropdown that looks pixel-identical to VTextField with a trailing chevron.
///
/// Uses a `Menu` containing an inline `Picker` for proper selection semantics
/// (automatic checkmarks, accessibility). The visual label is fully custom.
/// Expands to fill available width by default; callers can constrain with
/// `.frame(width:)` as needed.
public struct VDropdown<T: Hashable>: View {
    public let placeholder: String
    @Binding public var selection: T
    public let options: [(label: String, value: T)]
    /// When selection equals emptyValue, placeholder text is shown instead.
    public var emptyValue: T? = nil

    public init(
        placeholder: String,
        selection: Binding<T>,
        options: [(label: String, value: T)],
        emptyValue: T? = nil
    ) {
        self.placeholder = placeholder
        self._selection = selection
        self.options = options
        self.emptyValue = emptyValue
    }

    private var selectedLabel: String? {
        if let emptyValue = emptyValue, selection == emptyValue {
            return nil
        }
        return options.first(where: { $0.value == selection })?.label
    }

    public var body: some View {
        Menu {
            Picker("", selection: $selection) {
                ForEach(options, id: \.value) { option in
                    Text(option.label).tag(option.value)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            HStack(spacing: VSpacing.md) {
                Group {
                    if let label = selectedLabel {
                        Text(label)
                            .foregroundColor(VColor.contentDefault)
                    } else {
                        Text(placeholder)
                            .foregroundColor(VColor.contentTertiary)
                    }
                }
                .font(VFont.body)
                .frame(maxWidth: .infinity, alignment: .leading)

                VIconView(.chevronDown, size: 13)
                    .foregroundColor(VColor.contentTertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.xs)
            .frame(maxWidth: .infinity)
            .frame(height: 32)
            .vInputChrome()
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .accessibilityLabel(selectedLabel ?? placeholder)
        .frame(maxWidth: .infinity)
    }
}
