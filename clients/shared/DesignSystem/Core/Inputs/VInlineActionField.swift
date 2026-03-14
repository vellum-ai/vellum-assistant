import SwiftUI

/// An input field with an inline action button (e.g., Save, Send) inside a shared container.
/// The button sits on the right edge of the field, creating a cohesive input-action group.
///
/// Usage:
/// ```swift
/// VInlineActionField(text: $apiKey, placeholder: "Your API key", isSecure: true) {
///     store.saveKey(apiKey)
/// }
/// ```
///
/// Pass `allowEmpty: true` when saving an empty value is a valid action (e.g., clearing a URL).
/// Pass `isFocused:` to observe focus state and guard against async overwrites of in-progress edits.
public struct VInlineActionField: View {
    @Binding public var text: String
    public let placeholder: String
    public var actionLabel: String
    public var isSecure: Bool
    public var allowEmpty: Bool
    public let action: () -> Void

    /// Optional binding so parents can observe whether the field is focused.
    private var externalFocused: Binding<Bool>?

    @FocusState private var fieldFocused: Bool
    @State private var isHovered = false

    public init(
        text: Binding<String>,
        placeholder: String,
        actionLabel: String = "Save",
        isSecure: Bool = false,
        allowEmpty: Bool = false,
        isFocused: Binding<Bool>? = nil,
        action: @escaping () -> Void
    ) {
        self._text = text
        self.placeholder = placeholder
        self.actionLabel = actionLabel
        self.isSecure = isSecure
        self.allowEmpty = allowEmpty
        self.externalFocused = isFocused
        self.action = action
    }

    private var isActionDisabled: Bool {
        !allowEmpty && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var body: some View {
        HStack(spacing: 0) {
            inputField
                .focused($fieldFocused)
                .padding(.leading, VSpacing.md)
                .padding(.vertical, VSpacing.xs)
                .onSubmit {
                    if !isActionDisabled { action() }
                }

            Button {
                if !isActionDisabled { action() }
            } label: {
                Text(actionLabel)
                    .font(VFont.captionMedium)
                    .foregroundColor(isActionDisabled ? VColor.contentTertiary : VColor.auxWhite)
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.buttonV)
                    .background(
                        isActionDisabled
                            ? VColor.borderBase.opacity(0.5)
                            : (isHovered ? VColor.primaryHover : VColor.primaryBase)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    .animation(VAnimation.fast, value: isHovered)
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .disabled(isActionDisabled)
            .onHover { hovering in
                isHovered = isActionDisabled ? false : hovering
            }
            .padding(.trailing, VSpacing.sm)
        }
        .background(VColor.surfaceActive)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .onChange(of: fieldFocused) { _, focused in
            externalFocused?.wrappedValue = focused
        }
    }

    @ViewBuilder
    private var inputField: some View {
        if isSecure {
            SecureField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
        } else {
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
        }
    }
}

#if DEBUG

private struct VInlineActionFieldPreviewWrapper: View {
    @State private var text = ""
    @State private var secureText = ""

    var body: some View {
        ZStack {
            VColor.surfaceOverlay.ignoresSafeArea()
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
