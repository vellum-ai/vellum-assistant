import SwiftUI
import VellumAssistantShared

struct DocumentEditorPanelView: View {
    var documentManager: DocumentManager
    let connectionManager: GatewayConnectionManager
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // Header toolbar
            HStack(spacing: VSpacing.sm) {
                VIconView(.fileText, size: 14)
                    .foregroundStyle(VColor.contentTertiary)
                Text(documentManager.title)
                    .font(VFont.brandMini)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
                if documentManager.wordCount > 0 {
                    Text("\(documentManager.wordCount) words")
                        .font(VFont.numericMono)
                        .foregroundStyle(VColor.contentTertiary)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xxs)
                        .background(VColor.surfaceLift)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.chip))
                }
                if documentManager.isSaving {
                    ProgressView().controlSize(.small).scaleEffect(0.7)
                } else {
                    VSplitButton(
                        label: "Export",
                        icon: VIcon.arrowDownToLine.rawValue,
                        style: .ghost,
                        action: { documentManager.exportToFile() }
                    ) {
                        VMenuItem(label: "Export as PDF") {
                            documentManager.exportToPDF()
                        }
                    }
                }
                VButton(label: "Close", iconOnly: VIcon.x.rawValue, style: .ghost, action: onClose)
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
            .background(VColor.surfaceBase)

            Divider().background(VColor.borderBase)

            DocumentEditorView(
                documentManager: documentManager,
                onContentChanged: { title, content, wordCount in
                    documentManager.updateContent(title: title, content: content, wordCount: wordCount)
                }
            )
        }
    }
}
