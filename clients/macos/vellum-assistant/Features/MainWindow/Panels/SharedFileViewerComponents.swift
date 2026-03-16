import SwiftUI
import VellumAssistantShared

/// Formats a byte count into a human-readable size string.
/// Shows raw bytes for sizes < 1 KB (e.g. "500 B"), then "KB" / "MB" with one decimal place.
func formatFileSize(_ bytes: Int) -> String {
    if bytes < 1024 { return "\(bytes) B" }
    let kb = Double(bytes) / 1024.0
    if kb < 1024 { return String(format: "%.1f KB", kb) }
    let mb = kb / 1024.0
    return String(format: "%.1f MB", mb)
}

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
                .fixedSize(horizontal: true, vertical: false)
                .padding(VSpacing.md)
                .frame(alignment: .topLeading)
        }
    }
}

/// Header bar showing file icon, name, and size for file content viewers.
struct FileContentHeaderBar: View {
    let icon: VIcon
    let fileName: String
    let fileSize: String

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(icon, size: 12)
                .foregroundColor(VColor.primaryBase)
            Text(fileName)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.contentDefault)
            Spacer()
            Text(fileSize)
                .font(VFont.small)
                .foregroundColor(VColor.contentTertiary)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
    }
}
