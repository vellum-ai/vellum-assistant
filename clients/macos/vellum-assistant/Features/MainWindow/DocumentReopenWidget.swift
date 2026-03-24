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
                .foregroundColor(VColor.primaryBase)

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text("Document")
                    .font(VFont.labelDefault)
                    .foregroundColor(VColor.contentTertiary)

                Text(documentTitle)
                    .font(VFont.bodyMediumDefault)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(1)
            }

            Spacer()

            // Reopen button
            Button(action: onReopen) {
                Text("Open")
                    .font(VFont.bodyMediumDefault)
                    .foregroundColor(VColor.primaryBase)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.sm)
                            .fill(VColor.primaryBase.opacity(0.12))
                    )
            }
            .buttonStyle(.plain)

            // Dismiss button
            Button(action: onDismiss) {
                VIconView(.x, size: 11)
                    .foregroundColor(VColor.contentTertiary)
                    .frame(width: 20, height: 20)
            }
            .buttonStyle(.plain)
            .help("Dismiss")
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceBase)
                .shadow(color: VColor.auxBlack.opacity(0.12), radius: 8, x: 0, y: 2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(isHovered ? VColor.primaryBase.opacity(0.3) : VColor.borderBase, lineWidth: 1)
        )
        .onHover { hovering in
            withAnimation(VAnimation.fast) {
                isHovered = hovering
            }
        }
    }
}
