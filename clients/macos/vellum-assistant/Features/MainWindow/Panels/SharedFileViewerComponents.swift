import SwiftUI
import VellumAssistantShared

/// Empty state shown when no file is selected in a file viewer pane.
struct FileViewerEmptyState: View {
    var body: some View {
        VStack {
            Spacer()
            VIconView(.fileText, size: 32)
                .foregroundColor(VColor.contentTertiary)
                .padding(.bottom, VSpacing.sm)
            Text("Select a file to view")
                .font(VFont.body)
                .foregroundColor(VColor.contentTertiary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Scrollable read-only monospace text display for file content.
struct ReadOnlyCodeContent: View {
    let content: String

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            Text(content)
                .font(VFont.mono)
                .foregroundColor(VColor.contentDefault)
                .textSelection(.enabled)
                .padding(VSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
