import SwiftUI
import VellumAssistantShared

struct DocumentEditorPanelView: View {
    var documentManager: DocumentManager
    let connectionManager: GatewayConnectionManager
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // Header toolbar
            HStack {
                Text(documentManager.title)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
                if documentManager.wordCount > 0 {
                    Text("\(documentManager.wordCount) words")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
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
            .padding(.vertical, VSpacing.sm)
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
