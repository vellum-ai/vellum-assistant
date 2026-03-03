import SwiftUI

/// A styled dropdown that works on both macOS and iOS.
/// macOS: uses NSPopUpButton for reliable click handling.
/// iOS: uses SwiftUI Menu.
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
        #if os(macOS)
        VDropdownButton(
            label: selectedLabel,
            placeholder: placeholder,
            options: options.map { ($0.label, $0.value) },
            selection: $selection
        )
        .accessibilityLabel(selectedLabel ?? placeholder)
        .frame(maxWidth: .infinity)
        #else
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
            HStack(spacing: VSpacing.md) {
                Group {
                    if let label = selectedLabel {
                        Text(label)
                            .foregroundColor(VColor.textPrimary)
                    } else {
                        Text(placeholder)
                            .foregroundColor(VColor.textMuted)
                    }
                }
                .font(VFont.body)
                .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "chevron.down")
                    .foregroundColor(VColor.textMuted)
                    .font(.system(size: 14))
                    .accessibilityHidden(true)
            }
            .padding(VSpacing.md)
            .background(VColor.inputBackground)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
            )
        }
        .accessibilityLabel(selectedLabel ?? placeholder)
        .frame(maxWidth: .infinity)
        #endif
    }
}

// MARK: - macOS NSPopUpButton Implementation

#if os(macOS)
import AppKit

/// NSViewRepresentable that wraps an NSPopUpButton styled to match the design system.
/// This avoids SwiftUI Menu hit-testing issues entirely.
private struct VDropdownButton<T: Hashable>: NSViewRepresentable {
    let label: String?
    let placeholder: String
    let options: [(String, T)]
    @Binding var selection: T

    func makeNSView(context: Context) -> NSView {
        let button = NSPopUpButton(frame: .zero, pullsDown: false)
        button.bezelStyle = .roundRect
        button.isBordered = false
        button.font = NSFont(name: "Inter", size: 13) ?? NSFont.systemFont(ofSize: 13)
        button.target = context.coordinator
        button.action = #selector(Coordinator.selectionChanged(_:))

        populateItems(button)
        selectCurrentItem(button)

        // Wrap in a container with a styled border
        let container = NSView()
        container.wantsLayer = true
        container.layer?.cornerRadius = CGFloat(VRadius.md)
        container.layer?.borderWidth = 1
        container.layer?.borderColor = NSColor(VColor.surfaceBorder).withAlphaComponent(0.5).cgColor
        container.layer?.backgroundColor = NSColor(VColor.inputBackground).cgColor

        button.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(button)
        NSLayoutConstraint.activate([
            button.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 4),
            button.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -4),
            button.topAnchor.constraint(equalTo: container.topAnchor, constant: 2),
            button.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -2),
        ])

        // Store button reference for updates
        context.coordinator.button = button

        return container
    }

    func updateNSView(_ container: NSView, context: Context) {
        guard let button = context.coordinator.button else { return }
        let currentTitles = button.itemTitles
        let newTitles = options.map { $0.0 }
        if currentTitles != newTitles {
            populateItems(button)
        }
        selectCurrentItem(button)

        // Update border color for light/dark mode changes
        container.layer?.borderColor = NSColor(VColor.surfaceBorder).withAlphaComponent(0.5).cgColor
        container.layer?.backgroundColor = NSColor(VColor.inputBackground).cgColor
    }

    private func populateItems(_ button: NSPopUpButton) {
        button.removeAllItems()
        for (label, _) in options {
            button.addItem(withTitle: label)
        }
    }

    private func selectCurrentItem(_ button: NSPopUpButton) {
        if let idx = options.firstIndex(where: { $0.1 == selection }) {
            button.selectItem(at: idx)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    class Coordinator: NSObject {
        var parent: VDropdownButton
        weak var button: NSPopUpButton?

        init(_ parent: VDropdownButton) {
            self.parent = parent
        }

        @objc func selectionChanged(_ sender: NSPopUpButton) {
            let idx = sender.indexOfSelectedItem
            guard idx >= 0, idx < parent.options.count else { return }
            parent.selection = parent.options[idx].1
        }
    }
}
#endif

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
            VColor.background.ignoresSafeArea()
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
                    .foregroundColor(VColor.textMuted)
            }
            .padding()
        }
    }
}
#endif
