import SwiftUI
import VellumAssistantShared

// MARK: - File View Mode

enum FileViewMode: String, Hashable {
    case source
    case preview
    case tree
}

func availableViewModes(for fileName: String, mimeType: String) -> [FileViewMode] {
    let ext = (fileName as NSString).pathExtension.lowercased()
    let mime = mimeType.lowercased()
    if ext == "md" || ext == "markdown" || mime == "text/markdown" {
        return [.preview, .source]
    }
    if ext == "json" || mime == "application/json" {
        return [.tree, .source]
    }
    return [.source]
}

func viewModeLabel(_ mode: FileViewMode) -> String {
    switch mode {
    case .source: return "Source"
    case .preview: return "Preview"
    case .tree: return "Preview"
    }
}

/// Header bar showing file icon, name, and size for file content viewers.
struct FileContentHeaderBar<Trailing: View>: View {
    let icon: VIcon
    let fileName: String
    let fileSize: String
    let trailing: Trailing

    init(icon: VIcon, fileName: String, fileSize: String, @ViewBuilder trailing: () -> Trailing = { EmptyView() }) {
        self.icon = icon
        self.fileName = fileName
        self.fileSize = fileSize
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(icon, size: 12)
                .foregroundColor(VColor.primaryBase)
            Text(fileName)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.contentDefault)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Text(fileSize)
                .font(VFont.small)
                .foregroundColor(VColor.contentTertiary)
                .fixedSize()
            trailing
        }
        .padding(.horizontal, VSpacing.md)
        .frame(height: 36)
    }
}
