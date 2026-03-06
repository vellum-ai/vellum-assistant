import SwiftUI

public struct VSearchBar: View {
    public let placeholder: String
    @Binding public var text: String

    public init(placeholder: String = "Search...", text: Binding<String>) {
        self.placeholder = placeholder
        self._text = text
    }

    public var body: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.search, size: 12)
                .foregroundColor(VColor.textMuted)

            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

            if !text.isEmpty {
                Button(action: { text = "" }) {
                    VIconView(.circleX, size: 12)
                        .foregroundColor(VColor.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .frame(height: 28)
        .background(VColor.inputBackground)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }
}
