import SwiftUI

public struct VSearchBar: View {
    public let placeholder: String
    @Binding public var text: String
    @FocusState private var isFocused: Bool

    public init(placeholder: String = "Search...", text: Binding<String>) {
        self.placeholder = placeholder
        self._text = text
    }

    public var body: some View {
        HStack(spacing: VSpacing.md) {
            VIconView(.search, size: 12)
                .foregroundColor(VColor.contentTertiary)

            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(VFont.bodyMediumLighter)
                .foregroundColor(VColor.contentDefault)
                .focused($isFocused)

            if !text.isEmpty {
                Button(action: { text = "" }) {
                    VIconView(.circleX, size: 12)
                        .foregroundColor(VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .frame(height: 32)
        .vInputChrome(isFocused: isFocused)
    }
}
