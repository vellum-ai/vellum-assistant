import SwiftUI
import VellumAssistantShared

/// Recap card displaying a file reference with name and size.
/// Uses `HomeRecapCardHeader`
/// for the icon + title row, and `HomeLinkFileRow` for the file info.
struct HomeFileCard: View {
    let title: String
    let threadName: String?
    let fileName: String
    let fileSize: String
    let showDismiss: Bool
    let onDismiss: (() -> Void)?

    init(
        title: String,
        threadName: String? = nil,
        fileName: String,
        fileSize: String,
        showDismiss: Bool = false,
        onDismiss: (() -> Void)? = nil
    ) {
        self.title = title
        self.threadName = threadName
        self.fileName = fileName
        self.fileSize = fileSize
        self.showDismiss = showDismiss
        self.onDismiss = onDismiss
    }

    var body: some View {
        VStack(spacing: VSpacing.md) {
            HomeRecapCardHeader(
                icon: .file,
                title: title,
                subtitle: threadName,
                showDismiss: showDismiss,
                onDismiss: onDismiss
            )

            HomeLinkFileRow(
                icon: .file,
                fileName: fileName,
                fileSize: fileSize
            )
        }
        .recapCardGlass()
    }
}
