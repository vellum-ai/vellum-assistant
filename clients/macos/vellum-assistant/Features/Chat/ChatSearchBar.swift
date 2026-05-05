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
                .foregroundStyle(VColor.contentTertiary)

            TextField("Find in conversation...", text: $searchText)
                .textFieldStyle(.plain)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .focused($isFocused)
                .onSubmit { onNext() }

            if !searchText.isEmpty {
                Text(matchCount > 0 ? "\(currentMatchIndex + 1) of \(matchCount)" : "No results")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .fixedSize()

                Button(action: onPrevious) {
                    VIconView(.chevronUp, size: 12)
                        .foregroundStyle(matchCount > 0 ? VColor.contentDefault : VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .disabled(matchCount == 0)
                .accessibilityLabel("Previous match")

                Button(action: onNext) {
                    VIconView(.chevronDown, size: 12)
                        .foregroundStyle(matchCount > 0 ? VColor.contentDefault : VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .disabled(matchCount == 0)
                .accessibilityLabel("Next match")
            }

            Button(action: onDismiss) {
                VIconView(.x, size: 12)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close search")
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .frame(height: 32)
        .widthCap(280)
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
