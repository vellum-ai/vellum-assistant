import SwiftUI

/// A generic dropdown component styled to match VTextField.
/// Uses SwiftUI `Menu` for native macOS popup behavior.
public struct VDropdown<T: Hashable>: View {
    public let placeholder: String
    @Binding public var selection: T
    public let options: [(label: String, value: T)]
    /// When selection equals emptyValue, the placeholder text is shown instead of a selected label.
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
            ForEach(options, id: \.value) { option in
                Button {
                    selection = option.value
                } label: {
                    HStack {
                        Text(option.label)
                        if option.value == selection {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            HStack {
                if let label = selectedLabel {
                    Text(label)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                } else {
                    Text(placeholder)
                        .font(VFont.body)
                        .foregroundColor(VColor.textMuted)
                }

                Spacer()

                Image(systemName: "chevron.down")
                    .foregroundColor(VColor.textMuted)
                    .font(.system(size: 12))
            }
            .padding(VSpacing.md)
            .background(VColor.inputBackground)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize(horizontal: false, vertical: true)
    }
}

#if DEBUG
struct VDropdown_Preview: PreviewProvider {
    static var previews: some View {
        VDropdownPreviewWrapper()
            .frame(width: 350, height: 160)
            .previewDisplayName("VDropdown")
    }
}

private struct VDropdownPreviewWrapper: View {
    @State private var selection = ""

    private let options = [
        (label: "Option A", value: "a"),
        (label: "Option B", value: "b"),
        (label: "Option C", value: "c")
    ]

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            VStack(spacing: 16) {
                VDropdown(
                    placeholder: "Select an option...",
                    selection: $selection,
                    options: options,
                    emptyValue: ""
                )

                Text("Selected: \"\(selection)\"")
                    .font(VFont.mono)
                    .foregroundColor(VColor.textMuted)
            }
            .padding()
        }
    }
}
#endif
