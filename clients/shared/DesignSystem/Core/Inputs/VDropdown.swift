import SwiftUI

/// A generic dropdown that looks pixel-identical to VTextField with a trailing chevron.
///
/// Uses a `Menu` containing an inline `Picker` for proper selection semantics
/// (automatic checkmarks, accessibility). The visual label is fully custom and
/// the `.frame(maxWidth: .infinity)` is applied inside the label closure so the
/// borderless button style expands to fill the parent width.
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
            .background(VColor.surfaceActive)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.borderBase.opacity(0.5), lineWidth: 1)
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .accessibilityLabel(selectedLabel ?? placeholder)
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
