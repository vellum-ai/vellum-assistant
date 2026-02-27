import SwiftUI
#if os(macOS)
import AppKit
#endif

/// An input field with an inline action button (e.g., Save, Send) inside a shared container.
/// The button sits on the right edge of the field, creating a cohesive input-action group.
///
/// Usage:
/// ```swift
/// VInlineActionField(text: $apiKey, placeholder: "Your API key", isSecure: true) {
///     store.saveKey(apiKey)
/// }
/// ```
public struct VInlineActionField: View {
    @Binding public var text: String
    public let placeholder: String
    public var actionLabel: String
    public var isSecure: Bool
    public let action: () -> Void

    @State private var isHovered = false

    public init(
        text: Binding<String>,
        placeholder: String,
        actionLabel: String = "Save",
        isSecure: Bool = false,
        action: @escaping () -> Void
    ) {
        self._text = text
        self.placeholder = placeholder
        self.actionLabel = actionLabel
        self.isSecure = isSecure
        self.action = action
    }

    private var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var body: some View {
        HStack(spacing: 0) {
            inputField
                .padding(.leading, VSpacing.md)
                .padding(.vertical, VSpacing.md)
                .onSubmit {
                    if !isEmpty { action() }
                }

            Button {
                if !isEmpty { action() }
            } label: {
                Text(actionLabel)
                    .font(VFont.captionMedium)
                    .foregroundColor(isEmpty ? VColor.textMuted : .white)
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.buttonV)
                    .background(
                        isEmpty
                            ? VColor.surfaceBorder.opacity(0.5)
                            : (isHovered ? VColor.buttonPrimaryHover : VColor.buttonPrimary)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    .animation(VAnimation.fast, value: isHovered)
            }
            .buttonStyle(.plain)
            .disabled(isEmpty)
            .onHover { hovering in
                isHovered = isEmpty ? false : hovering
                #if os(macOS)
                if !isEmpty {
                    if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                }
                #endif
            }
            .padding(.trailing, VSpacing.sm)
        }
        .background(VColor.inputBackground)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
    }

    @ViewBuilder
    private var inputField: some View {
        if isSecure {
            SecureField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
        } else {
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
        }
    }
}

#if DEBUG
struct VInlineActionField_Preview: PreviewProvider {
    static var previews: some View {
        VInlineActionFieldPreviewWrapper()
            .frame(width: 450, height: 200)
            .previewDisplayName("VInlineActionField")
    }
}

private struct VInlineActionFieldPreviewWrapper: View {
    @State private var text = ""
    @State private var secureText = ""

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            VStack(spacing: 16) {
                VInlineActionField(text: $text, placeholder: "Enter a value") {}
                VInlineActionField(text: $secureText, placeholder: "Your API key", isSecure: true) {}
                VInlineActionField(text: $text, placeholder: "@username or chat ID", actionLabel: "Send") {}
            }
            .padding()
        }
    }
}
#endif
