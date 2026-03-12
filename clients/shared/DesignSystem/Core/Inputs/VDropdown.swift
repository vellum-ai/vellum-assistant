import SwiftUI

/// A generic dropdown that looks pixel-identical to VTextField with a trailing chevron.
/// Uses a ZStack: the visual layer is a plain styled HStack (no Menu chrome),
/// and the interactive layer is a transparent Menu overlay on top.
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
        ZStack {
            // Visual layer — identical to VTextField(trailingIcon: "chevron.down")
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
            .frame(height: 28)
            .background(VColor.surfaceActive)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.borderBase.opacity(0.5), lineWidth: 1)
            )

            // Interaction layer — transparent Menu, no visual chrome
            Menu {
                ForEach(options, id: \.value) { option in
                    Button {
                        selection = option.value
                    } label: {
                        HStack {
                            Text(option.label)
                            if option.value == selection {
                                VIconView(.check, size: 12)
                            }
                        }
                    }
                }
            } label: {
                Color.clear.contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .accessibilityLabel(selectedLabel ?? placeholder)
        }
        .frame(maxWidth: .infinity)
    }
}

#if DEBUG
struct VDropdown_Preview: PreviewProvider {
    static var previews: some View {
        VDropdownPreviewWrapper()
            .frame(width: 350, height: 200)
            .previewDisplayName("VDropdown vs VTextField")
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
            VColor.surfaceOverlay.ignoresSafeArea()
            VStack(spacing: VSpacing.md) {
                VDropdown(
                    placeholder: "Select an option\u{2026}",
                    selection: $selection,
                    options: options,
                    emptyValue: ""
                )

                TextField("Leave empty for daemon default", text: .constant(""))
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
