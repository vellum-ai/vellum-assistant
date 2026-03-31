import AppKit
import SwiftUI
import VellumAssistantShared

// MARK: - File View Mode

/// The display mode for file content: raw source text, rendered preview
/// (Markdown), or structured tree (JSON).
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

func fileIcon(for mimeType: String, fileName: String? = nil) -> VIcon {
    if mimeType.hasPrefix("image/") { return .image }
    if mimeType.hasPrefix("video/") { return .video }
    if mimeType.hasPrefix("text/") { return .fileText }
    if mimeType == "application/json" || mimeType == "application/javascript" || mimeType == "application/typescript" { return .fileCode }
    if let name = fileName, FileExtensions.isCode(name) { return .fileCode }
    return .file
}


// MARK: - File Content View

/// Displays file content with a header bar, view mode segmented control,
/// and a floating hover overlay for common actions (Edit, Copy,
/// Expand/Collapse). Supports source, preview (Markdown), and tree
/// (JSON) modes.
struct FileContentView: View {
    /// Frame size (points) for icon-only buttons in the hover overlay.
    private static let overlayIconSize: CGFloat = 28

    let fileName: String
    let mimeType: String
    @Binding var content: String
    @Binding var viewMode: FileViewMode
    var isEditable: Bool = false
    var showReadOnlyBadge: Bool = false
    var onTextChange: ((String) -> Void)? = nil
    @Binding var isActivelyEditing: Bool
    /// Unique identity for the file, used to force SwiftUI to recreate the
    /// HighlightedTextView when the underlying file changes. Defaults to
    /// `fileName`, but callers should pass a full path when the display name
    /// alone is not unique (e.g. files with the same basename in different
    /// directories).
    var fileIdentity: String? = nil
    @State private var isContentHovered = false
    @State private var expandAllTrigger = 0
    @State private var collapseAllTrigger = 0
    @State private var isTreeExpanded = false

    private func syncViewMode() {
        let modes = availableViewModes(for: fileName, mimeType: mimeType)
        if !modes.contains(viewMode) {
            viewMode = modes.first ?? .source
        }
    }

    var body: some View {
        let modes = availableViewModes(for: fileName, mimeType: mimeType)

        VStack(alignment: .leading, spacing: 0) {
            FileContentHeaderBar(
                icon: fileIcon(for: mimeType, fileName: fileName),
                fileName: fileName
            ) {
                if modes.count > 1 {
                    VTabs(
                        items: modes.map { (label: viewModeLabel($0), tag: $0) },
                        selection: $viewMode,
                        style: .pill
                    )
                    .fixedSize()
                }

                if showReadOnlyBadge {
                    Text("Read-only")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }

            Rectangle().fill(VColor.surfaceBase).frame(height: 1)

            ZStack(alignment: .topTrailing) {
                switch viewMode {
                case .source:
                    HighlightedTextView(
                        text: isEditable ? $content : .constant(content),
                        language: SyntaxLanguage.detect(fileName: fileName, mimeType: mimeType),
                        isEditable: isEditable,
                        isActivelyEditing: $isActivelyEditing,
                        onTextChange: onTextChange
                    )
                    .id(fileIdentity ?? fileName)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .preview:
                    MarkdownPreviewView(content: content)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                case .tree:
                    JSONTreeView(
                        content: content,
                        expandAllTrigger: expandAllTrigger,
                        collapseAllTrigger: collapseAllTrigger
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }

                if isContentHovered && !isActivelyEditing {
                    hoverOverlay
                }
            }
            .onHover { hovering in
                isContentHovered = hovering
            }
        }
        .onChange(of: viewMode) { _, newMode in
            if newMode != .source { isActivelyEditing = false }
            if newMode != .tree { isTreeExpanded = false }
            let modes = availableViewModes(for: fileName, mimeType: mimeType)
            guard modes.count > 1 else { return }
            let preference = newMode == .source ? "source" : "preview"
            UserDefaults.standard.set(preference, forKey: "fileViewerPreferredMode")
        }
        .onChange(of: fileName) { _, _ in
            isActivelyEditing = false
            isTreeExpanded = false
            syncViewMode()
        }
        .onAppear { syncViewMode() }
        .onChange(of: mimeType) { syncViewMode() }
        // Keyboard shortcut: Cmd+E to enter edit mode (source view only)
        .background {
            if isEditable && viewMode == .source && !isActivelyEditing {
                Button("") { isActivelyEditing = true }
                    .keyboardShortcut("e", modifiers: .command)
                    .hidden()
            }
        }
    }

    // MARK: - Hover Overlay

    /// Floating toolbar shown on hover over the file content area.
    /// Source mode: Edit + Copy. Tree mode: Expand All + Collapse All + Copy.
    /// Preview mode: Copy only.
    @ViewBuilder
    private var hoverOverlay: some View {
        HStack(spacing: VSpacing.xs) {
            if isEditable && viewMode == .source {
                VButton(
                    label: "Edit",
                    iconOnly: VIcon.pencil.rawValue,
                    style: .ghost,
                    iconSize: Self.overlayIconSize,
                    tooltip: "Edit"
                ) {
                    isActivelyEditing = true
                }
            }

            if viewMode == .tree {
                VButton(
                    label: isTreeExpanded ? "Collapse All" : "Expand All",
                    iconOnly: (isTreeExpanded ? VIcon.minimize : VIcon.maximize).rawValue,
                    style: .ghost,
                    iconSize: Self.overlayIconSize,
                    tooltip: isTreeExpanded ? "Collapse All" : "Expand All"
                ) {
                    if isTreeExpanded {
                        collapseAllTrigger += 1
                    } else {
                        expandAllTrigger += 1
                    }
                    isTreeExpanded.toggle()
                }
            }

            VCopyButton(text: content, iconSize: Self.overlayIconSize, accessibilityHint: "Copy all")
        }
        .padding(VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceOverlay.opacity(0.9))
        )
        .padding(.top, VSpacing.sm)
        .padding(.trailing, VSpacing.md)
    }
}

// MARK: - File Content Header Bar

/// Header bar showing a file icon, name, and optional trailing content
/// (e.g. a segmented control or read-only badge).
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
                .foregroundStyle(VColor.primaryBase)
                .padding(6)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .fill(VColor.surfaceActive)
                )
            Text(fileName)
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            trailing
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
    }
}
