import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Multi-line free-form text input.
///
/// On macOS, backed by an `NSViewRepresentable` wrapping `NSTextView` so
/// text-container insets (`lineFragmentPadding`, `textContainerInset`) can be
/// set explicitly. SwiftUI's `TextEditor` does not expose these values and
/// their effective defaults drift across macOS versions, which prevents a
/// sibling placeholder overlay from aligning with the rendered caret.
///
/// On iOS, backed by SwiftUI's native `TextEditor`.
///
/// The placeholder overlay uses the same inset values as the underlying
/// `NSTextView` so it sits directly behind the first caret position.
public struct VTextEditor: View {
    public let placeholder: String
    @Binding public var text: String
    public var minHeight: CGFloat = 80
    public var maxHeight: CGFloat = 200

    @FocusState private var isFocused: Bool

    public init(placeholder: String, text: Binding<String>, minHeight: CGFloat = 80, maxHeight: CGFloat = 200) {
        self.placeholder = placeholder
        self._text = text
        self.minHeight = minHeight
        self.maxHeight = maxHeight
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            editor

            if text.isEmpty {
                Text(placeholder)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentTertiary)
                    .padding(.leading, placeholderInsetX)
                    .padding(.top, placeholderInsetY)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: minHeight, maxHeight: maxHeight, alignment: .topLeading)
        .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.md, bottom: VSpacing.sm, trailing: VSpacing.md))
        .contentShape(Rectangle())
        .simultaneousGesture(TapGesture().onEnded { isFocused = true })
        .vInputChrome(isFocused: isFocused)
    }

    @ViewBuilder
    private var editor: some View {
        #if os(macOS)
        VTextEditorNSTextView(
            text: $text,
            shouldFocus: isFocused,
            font: VFont.nsBodyMediumLighter,
            textColor: NSColor(VColor.contentDefault),
            accessibilityLabel: placeholder,
            onFocusChanged: { newValue in
                if isFocused != newValue { isFocused = newValue }
            }
        )
        .focusable(true)
        .focused($isFocused)
        #else
        TextEditor(text: $text)
            .font(VFont.bodyMediumLighter)
            .foregroundStyle(VColor.contentDefault)
            .scrollContentBackground(.hidden)
            .background(Color.clear)
            .focused($isFocused)
            .accessibilityLabel(placeholder)
        #endif
    }

    /// Horizontal placeholder offset matches the underlying editor's leading
    /// text inset so the placeholder sits directly over the caret.
    private var placeholderInsetX: CGFloat {
        #if os(macOS)
        VTextEditorNSTextView.textInsetX
        #else
        5
        #endif
    }

    /// Vertical placeholder offset matches the underlying editor's top text
    /// inset so the placeholder sits directly over the caret.
    private var placeholderInsetY: CGFloat {
        #if os(macOS)
        VTextEditorNSTextView.textInsetY
        #else
        8
        #endif
    }
}
