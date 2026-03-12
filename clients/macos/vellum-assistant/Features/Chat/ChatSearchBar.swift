import SwiftUI
import VellumAssistantShared

/// In-chat find bar (Cmd+F). Searches message text and navigates between matches.
struct ChatSearchBar: View {
    @Binding var searchText: String
    let matchCount: Int
    let currentMatchIndex: Int
    let onPrevious: () -> Void
    let onNext: () -> Void
    let onDismiss: () -> Void

    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.search, size: 12)
                .foregroundColor(VColor.contentTertiary)

            TextField("Find in conversation...", text: $searchText)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .focused($isFocused)
                .onSubmit { onNext() }

            if !searchText.isEmpty {
                Text(matchCount > 0 ? "\(currentMatchIndex + 1) of \(matchCount)" : "No results")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .fixedSize()

                Button(action: onPrevious) {
                    VIconView(.chevronUp, size: 12)
                        .foregroundColor(matchCount > 0 ? VColor.contentDefault : VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .disabled(matchCount == 0)
                .accessibilityLabel("Previous match")

                Button(action: onNext) {
                    VIconView(.chevronDown, size: 12)
                        .foregroundColor(matchCount > 0 ? VColor.contentDefault : VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .disabled(matchCount == 0)
                .accessibilityLabel("Next match")
            }

            Button(action: onDismiss) {
                VIconView(.x, size: 12)
                    .foregroundColor(VColor.contentTertiary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close search")
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .frame(height: 32)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .vShadow(VShadow.sm)
        .onAppear { isFocused = true }
        .onKeyPress(.escape) {
            onDismiss()
            return .handled
        }
    }
}

// MARK: - Preview

#if DEBUG
struct ChatSearchBar_Preview: PreviewProvider {
    static var previews: some View {
        ChatSearchBarPreviewWrapper()
            .frame(width: 400)
            .previewDisplayName("ChatSearchBar")
    }
}

private struct ChatSearchBarPreviewWrapper: View {
    @State private var text = "hello"

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            ChatSearchBar(
                searchText: $text,
                matchCount: 5,
                currentMatchIndex: 2,
                onPrevious: {},
                onNext: {},
                onDismiss: {}
            )
            .padding()
        }
    }
}
#endif
