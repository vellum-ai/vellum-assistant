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
    if ext == "json" || mime.hasPrefix("application/json") {
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

// MARK: - File Icon

func fileIcon(for mimeType: String) -> VIcon {
    if mimeType.hasPrefix("image/") { return .image }
    if mimeType.hasPrefix("video/") { return .video }
    if mimeType.hasPrefix("text/") { return .fileText }
    if mimeType == "application/json" || mimeType == "application/javascript" || mimeType == "application/typescript" { return .fileCode }
    return .file
}

// MARK: - File Content View

struct FileContentView: View {
    let fileName: String
    let mimeType: String
    @Binding var content: String
    @Binding var viewMode: FileViewMode
    var isEditable: Bool = false
    var showReadOnlyBadge: Bool = false
    var onTextChange: ((String) -> Void)? = nil
    @Binding var isActivelyEditing: Bool
    @State private var isContentHovered = false

    var body: some View {
        let modes = availableViewModes(for: fileName, mimeType: mimeType)
        let effectiveMode = modes.contains(viewMode) ? viewMode : (modes.first ?? .source)

        VStack(alignment: .leading, spacing: 0) {
            FileContentHeaderBar(
                icon: fileIcon(for: mimeType),
                fileName: fileName
            ) {
                if modes.count > 1 {
                    VSegmentedControl(
                        items: modes.map { (label: viewModeLabel($0), tag: $0) },
                        selection: $viewMode,
                        style: .pill,
                        size: .compact
                    )
                    .fixedSize()
                }

                if showReadOnlyBadge {
                    Text("Read-only")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
            }

            Divider().background(VColor.borderBase)

            ZStack(alignment: .topTrailing) {
                switch effectiveMode {
                case .source:
                    HighlightedTextView(
                        text: isEditable ? $content : .constant(content),
                        language: SyntaxLanguage.detect(fileName: fileName, mimeType: mimeType),
                        isEditable: isEditable,
                        isActivelyEditing: $isActivelyEditing,
                        onTextChange: onTextChange
                    )
                    .id(fileName)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .preview:
                    MarkdownPreviewView(content: content)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                case .tree:
                    JSONTreeView(content: content)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }

                if isContentHovered && !isActivelyEditing {
                    HStack(spacing: VSpacing.md) {
                        if isEditable {
                            Button(action: {
                                viewMode = .source
                                isActivelyEditing = true
                            }) {
                                VIconView(.pencil, size: 14)
                                    .foregroundColor(VColor.contentSecondary)
                            }
                            .buttonStyle(.plain)
                            .help("Edit")
                            .accessibilityLabel("Edit")
                            .pointerCursor()
                        }

                        VCopyButton(text: content, iconSize: 14, accessibilityHint: "Copy all")
                    }
                    .padding(VSpacing.sm)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .fill(VColor.surfaceOverlay.opacity(0.9))
                    )
                    .padding(VSpacing.sm)
                }
            }
            .onHover { hovering in
                isContentHovered = hovering
            }
        }
        .onChange(of: viewMode) { _, newMode in
            if newMode != .source { isActivelyEditing = false }
            let modes = availableViewModes(for: fileName, mimeType: mimeType)
            guard modes.count > 1 else { return }
            let preference = newMode == .source ? "source" : "preview"
            UserDefaults.standard.set(preference, forKey: "fileViewerPreferredMode")
        }
        .onChange(of: fileName) { _, _ in
            isActivelyEditing = false
        }
    }
}

// MARK: - File Content Header Bar

/// Header bar showing file icon and name for file content viewers.
struct FileContentHeaderBar<Trailing: View>: View {
    let icon: VIcon
    let fileName: String
    let trailing: Trailing

    init(icon: VIcon, fileName: String, @ViewBuilder trailing: () -> Trailing = { EmptyView() }) {
        self.icon = icon
        self.fileName = fileName
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
            trailing
        }
        .padding(.horizontal, VSpacing.sm)
        .frame(height: 36)
    }
}
