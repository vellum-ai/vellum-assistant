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
                    VIconButton(label: "Export", icon: VIcon.arrowDownToLine.rawValue, isActive: false, iconOnly: true) {
                        documentManager.exportToFile()
                    }
                }
                VIconButton(label: "Close", icon: VIcon.x.rawValue, isActive: false, iconOnly: true, action: onClose)
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
