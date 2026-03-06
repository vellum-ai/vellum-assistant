import SwiftUI
import VellumAssistantShared

/// Widget shown in chat when a document exists but the workspace is closed.
/// Allows users to re-open the document editor.
struct DocumentReopenWidget: View {
    let documentTitle: String
    let onReopen: () -> Void
    let onDismiss: () -> Void

    @State private var isHovered = false

    var body: some View {
        HStack(spacing: VSpacing.md) {
            // Document icon
            VIconView(.fileText, size: 16)
                .foregroundColor(VColor.accent)

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text("Document")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.textMuted)

                Text(documentTitle)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)
            }

            Spacer()

            // Reopen button
            Button(action: onReopen) {
                Text("Open")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.accent)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.sm)
                            .fill(VColor.accent.opacity(0.12))
                    )
            }
            .buttonStyle(.plain)

            // Dismiss button
            Button(action: onDismiss) {
                VIconView(.x, size: 11)
                    .foregroundColor(VColor.textMuted)
                    .frame(width: 20, height: 20)
            }
            .buttonStyle(.plain)
            .help("Dismiss")
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surface)
                .shadow(color: Color.black.opacity(0.12), radius: 8, x: 0, y: 2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(isHovered ? VColor.accent.opacity(0.3) : VColor.surfaceBorder, lineWidth: 1)
        )
        .onHover { hovering in
            withAnimation(VAnimation.fast) {
                isHovered = hovering
            }
        }
    }
}

#if DEBUG
#Preview("Document Reopen Widget") {
    ZStack {
        VColor.background.ignoresSafeArea()

        DocumentReopenWidget(
            documentTitle: "NYC Pizza: A Love Letter",
            onReopen: { print("Reopen tapped") },
            onDismiss: { print("Dismiss tapped") }
        )
        .padding(VSpacing.xl)
        .frame(width: 400)
    }
}
#endif
