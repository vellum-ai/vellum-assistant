import AppKit
import SwiftUI
import VellumAssistantShared

// MARK: - NoFocusRingTextField

/// Invisible NSTextField with no focus ring, used as the keyboard sink for PINCircleField.
struct NoFocusRingTextField: NSViewRepresentable {
    @Binding var text: String
    var digitCount: Int
    /// Called once when the view is created so the parent can hold a reference for tap-to-focus.
    var onMakeView: ((NSTextField) -> Void)?

    func makeCoordinator() -> Coordinator { Coordinator(text: $text, digitCount: digitCount) }

    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField()
        field.isBordered = false
        field.isBezeled = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = NSFont.systemFont(ofSize: 1)
        field.alphaValue = 0.01
        field.delegate = context.coordinator
        context.coordinator.field = field
        onMakeView?(field)
        DispatchQueue.main.async { field.window?.makeFirstResponder(field) }
        return field
    }

    func updateNSView(_ nsView: NSTextField, context: Context) {
        context.coordinator.digitCount = digitCount
        if nsView.stringValue != text { nsView.stringValue = text }
    }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        @Binding var text: String
        var digitCount: Int
        weak var field: NSTextField?

        init(text: Binding<String>, digitCount: Int) {
            _text = text
            self.digitCount = digitCount
        }

        func controlTextDidChange(_ obj: Notification) {
            guard let field = obj.object as? NSTextField else { return }
            let filtered = String(field.stringValue.filter { $0.isNumber }.prefix(digitCount))
            text = filtered
            if field.stringValue != filtered { field.stringValue = filtered }
        }
    }
}

// MARK: - PINCircleField

/// iPhone-style PIN entry: N dot circles that fill as digits are typed.
/// Uses a no-focus-ring NSTextField underneath to capture keyboard input.
struct PINCircleField: View {
    @Binding var text: String
    var count: Int = 6
    /// Increment this from the parent to force a focus grab without rebuilding
    /// the view (e.g. after showing an error on the same step).
    var focusTrigger: Int = 0

    @State private var inputField: NSTextField?

    var body: some View {
        HStack(spacing: 14) {
            ForEach(0..<count, id: \.self) { index in
                Circle()
                    .fill(index < text.count ? VColor.accent : Color.clear)
                    .overlay(
                        Circle().strokeBorder(
                            index < text.count ? VColor.accent : VColor.textMuted,
                            lineWidth: 2
                        )
                    )
                    .frame(width: 18, height: 18)
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .overlay(
            NoFocusRingTextField(text: $text, digitCount: count) { field in
                inputField = field
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        )
        .contentShape(Rectangle())
        .onTapGesture { inputField?.window?.makeFirstResponder(inputField) }
        .onChange(of: focusTrigger) { _, _ in
            DispatchQueue.main.async {
                if let field = inputField {
                    field.window?.makeFirstResponder(field)
                }
            }
        }
    }
}
