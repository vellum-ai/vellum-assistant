import SwiftUI
import VellumAssistantShared

struct DocumentEditorPanelView: View {
    @ObservedObject var documentManager: DocumentManager
    let daemonClient: DaemonClient
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // Header toolbar
            HStack {
                Text(documentManager.title)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
                if documentManager.wordCount > 0 {
                    Text("\(documentManager.wordCount) words")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                }
                if documentManager.isSaving {
                    ProgressView().controlSize(.small).scaleEffect(0.7)
                } else {
                    VButton(label: "Export", iconOnly: VIcon.arrowDownToLine.rawValue, style: .ghost) {
                        documentManager.exportToFile()
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
