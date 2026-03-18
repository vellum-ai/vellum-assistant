import SwiftUI

/// A generic dropdown that looks pixel-identical to VTextField with a trailing chevron.
///
/// Uses a `Menu` containing an inline `Picker` for proper selection semantics
/// (automatic checkmarks, accessibility). The visual label is fully custom.
/// Defaults to 400pt fixed width; callers can pass a custom `width` to override,
/// or use `maxWidth` instead for a flexible upper bound that allows shrinking.
public struct VDropdown<T: Hashable>: View {
    public let placeholder: String
    @Binding public var selection: T
    public let options: [(label: String, value: T)]
    /// When selection equals emptyValue, placeholder text is shown instead.
    public var emptyValue: T? = nil
    /// Fixed width of the dropdown. Defaults to 400. Ignored when `maxWidth` is set.
    public var width: CGFloat = 400
    /// Optional flexible upper bound. When set, the dropdown can shrink below this
    /// value in narrow containers instead of using a fixed width.
    public var maxWidth: CGFloat? = nil

    public init(
        placeholder: String,
        selection: Binding<T>,
        options: [(label: String, value: T)],
        emptyValue: T? = nil,
        width: CGFloat = 400,
        maxWidth: CGFloat? = nil
    ) {
        self.placeholder = placeholder
        self._selection = selection
        self.options = options
        self.emptyValue = emptyValue
        self.width = width
        self.maxWidth = maxWidth
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
        .frame(width: maxWidth == nil ? width : nil,
               maxWidth: maxWidth)
    }
}

#if DEBUG

private struct VDropdownPreviewWrapper: View {
    @State private var selection = ""

    private let options = [
        (label: "Option A", value: "a"),
        (label: "Option B", value: "b"),
        (label: "Option C", value: "c")
    ]

    var body: some View {
        ZStack {
            VColor.surfaceOverlay.ignoresSafeArea()
            VStack(spacing: VSpacing.md) {
                VDropdown(
                    placeholder: "Select an option\u{2026}",
                    selection: $selection,
                    options: options,
                    emptyValue: ""
                )

                TextField("Leave empty for assistant default", text: .constant(""))
                    .vInputStyle()
                    .font(VFont.body)

                Text("Selected: \"\(selection)\"")
                    .font(VFont.mono)
                    .foregroundColor(VColor.contentTertiary)
            }
            .padding()
        }
    }
}
#endif
