import VellumAssistantShared
import SwiftUI

struct DirectoryPanel: View {
    var onClose: () -> Void
    var body: some View {
        VSidePanel(title: "Directory", onClose: onClose) {
            VEmptyState(title: "No files", subtitle: "Markdown files will appear here", icon: "doc.text")
        }
    }
}

#Preview {
    DirectoryPanel(onClose: {})
}
