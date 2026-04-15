import AppKit
import SwiftUI
import VellumAssistantShared

/// An expandable card that renders file attachment content inline in chat.
/// Collapsed state shows a compact chip (matching `fileAttachmentChip`);
/// expanded state shows a scrollable content area with markdown or code
/// rendering via `MarkdownSegmentView`.
///
/// Expansion state lives in a `FilePreviewExpansionStore` injected via
/// `@Environment` rather than local `@State`, so manual expansion survives
/// the view-tree destruction that happens when `MessageListContentView`
/// flips its `.if` min-height wrapper at the start/end of an active turn.
struct InlineFilePreviewView: View {
    let attachment: ChatAttachment
    let isUser: Bool
    let messageId: UUID

    /// Height cap for the content area when content exceeds the line threshold.
    private static let maxContentHeight: CGFloat = 400
    /// Line threshold for switching to the fixed-height ScrollView path.
    /// At ~16pt line height, 25 lines = ~400pt, matching `maxContentHeight`.
    private static let lineThreshold = 25
    /// Byte threshold for single-line mega-strings (e.g., minified JSON) that
    /// wrap into many visual lines despite having few newlines.
    private static let charThreshold = 50_000

    @Environment(\.filePreviewExpansionStore) private var expansionStore
    @State private var cachedContent: String? = nil
    @State private var isLoading: Bool = false
    @State private var loadError: Bool = false

    /// Cached parsed markdown segments — parsed lazily only when the card is
    /// expanded, avoiding synchronous O(n) work on every render pass.
    @State private var cachedSegments: [MarkdownSegment] = []
    /// Tracks the content string that `cachedSegments` was built from, so we
    /// only re-parse when content actually changes.
    @State private var lastParsedContent: String? = nil

    private var expansionKey: String {
        "file-preview-\(messageId.uuidString)-\(attachment.id)"
    }

    private var isExpanded: Bool {
        expansionStore.isExpanded(expansionKey)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerRow

            if isExpanded {
                Divider()
                    .padding(.horizontal, VSpacing.sm)

                contentArea
            }
        }
        .background(isExpanded ? VColor.surfaceOverlay : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: isExpanded ? VRadius.md : VRadius.sm))
        .animation(VAnimation.fast, value: isExpanded)
        .onAppear {
            loadContentIfNeeded()
            syncSegmentsIfNeeded()
        }
        .onChange(of: isExpanded) { _, _ in
            loadContentIfNeeded()
            syncSegmentsIfNeeded()
        }
        .onChange(of: cachedContent) { _, _ in syncSegmentsIfNeeded() }
    }

    // MARK: - Header

    private var headerRow: some View {
        Button(action: {
            withAnimation(VAnimation.fast) {
                expansionStore.toggle(expansionKey)
            }
        }) {
            HStack(spacing: VSpacing.xs) {
                VIconView(fileIcon(for: attachment.mimeType, fileName: attachment.filename), size: 14)
                    .foregroundStyle(VColor.contentSecondary)

                Text(attachment.filename)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)

                if attachment.dataLength > 0 {
                    Text(formattedFileSize(base64Length: attachment.dataLength))
                        .font(VFont.labelSmall)
                        .foregroundStyle(isUser ? VColor.contentSecondary : VColor.contentTertiary)
                }

                if isExpanded {
                    Spacer()

                    if let content = cachedContent, !isLoading {
                        VCopyButton(text: content, iconSize: 20)
                    }

                    VButton(
                        label: "Save",
                        iconOnly: VIcon.arrowDownToLine.rawValue,
                        style: .ghost,
                        iconSize: 20,
                        action: { saveFileAttachment(attachment) }
                    )

                    VIconView(.chevronUp, size: 9)
                        .foregroundStyle(VColor.contentTertiary)
                } else {
                    VIconView(.chevronDown, size: 9)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .environment(\.isEnabled, true)
        .background(
            Group {
                if !isExpanded {
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .fill(isUser ? VColor.contentDefault.opacity(0.15) : VColor.borderBase.opacity(0.5))
                }
            }
        )
        .pointerCursor()
    }

    // MARK: - Content Area

    @ViewBuilder
    private var contentArea: some View {
        if isLoading {
            loadingView
        } else if loadError {
            errorView
        } else if let content = cachedContent {
            let lineCount = content.utf8.reduce(1) { $0 + ($1 == 0x0A ? 1 : 0) }
            if lineCount > Self.lineThreshold || content.utf8.count > Self.charThreshold {
                ScrollView {
                    markdownContent
                }
                .frame(height: Self.maxContentHeight)
            } else {
                markdownContent
            }
        } else {
            loadingView
        }
    }

    private var markdownContent: some View {
        MarkdownSegmentView(
            segments: cachedSegments,
            isStreaming: false,
            maxContentWidth: nil,
            textColor: VColor.contentDefault,
            secondaryTextColor: VColor.contentSecondary,
            mutedTextColor: VColor.contentTertiary,
            tintColor: VColor.primaryBase,
            codeTextColor: VColor.contentDefault,
            codeBackgroundColor: VColor.surfaceBase
        )
        .padding(VSpacing.sm)
    }

    private var loadingView: some View {
        HStack(spacing: VSpacing.xs) {
            Spacer(minLength: 0)
            ProgressView()
                .controlSize(.small)
            Text("Loading...")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
            Spacer(minLength: 0)
        }
        .padding(VSpacing.sm)
    }

    private var errorView: some View {
        HStack {
            Spacer(minLength: 0)
            Text("Failed to load file content")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
            Spacer(minLength: 0)
        }
        .padding(VSpacing.sm)
    }

    // MARK: - Content Loading

    /// Load content lazily on first expand. Mirrors the ThinkingBlockView
    /// cache-sync pattern: called from both `onAppear` and `onChange(of: isExpanded)`.
    private func loadContentIfNeeded() {
        guard isExpanded, cachedContent == nil, !isLoading else { return }

        if attachment.isLazyLoad {
            isLoading = true
            Task {
                do {
                    let data = try await AttachmentContentClient.fetchContent(attachmentId: attachment.id)
                    let text = String(data: data, encoding: .utf8) ?? ""
                    loadError = false
                    cachedContent = text
                    isLoading = false
                } catch {
                    loadError = true
                    isLoading = false
                }
            }
        } else {
            if let text = attachment.decodedTextContent() {
                loadError = false
                cachedContent = text
            } else {
                loadError = true
            }
        }
    }

    /// Sync the segment cache when content changes. Mirrors the
    /// `ThinkingBlockView.syncCacheIfExpanded()` pattern: only re-parses when
    /// `cachedContent` has drifted from what was last parsed.
    private func syncSegmentsIfNeeded() {
        guard isExpanded, let content = cachedContent, content != lastParsedContent else { return }
        lastParsedContent = content
        cachedSegments = segmentsForContent(content)
    }

    // MARK: - Content Rendering

    /// Build markdown segments based on file type. Markdown files get full
    /// markdown parsing; code/JSON/other text files render as fenced code blocks.
    private func segmentsForContent(_ content: String) -> [MarkdownSegment] {
        let ext = (attachment.filename as NSString).pathExtension.lowercased()
        let isMarkdown = ext == "md" || ext == "markdown" || attachment.mimeType == "text/markdown"

        if isMarkdown {
            return parseMarkdownSegments(content)
        } else {
            return [.codeBlock(language: attachment.fileLanguageHint, code: content)]
        }
    }

    // MARK: - File Helpers

    /// Determine the appropriate icon for the file's MIME type and name.
    /// Mirrors the logic in `ChatBubble.fileIcon(for:fileName:)`.
    private func fileIcon(for mimeType: String, fileName: String? = nil) -> VIcon {
        if mimeType.hasPrefix("video/") { return .video }
        if mimeType.hasPrefix("audio/") { return .audioWaveform }
        if mimeType.hasPrefix("text/") { return .fileText }
        if mimeType == "application/pdf" { return .file }
        if mimeType.contains("zip") || mimeType.contains("archive") { return .fileArchive }
        if mimeType.contains("json") || mimeType.contains("xml") { return .fileText }
        if let name = fileName, FileExtensions.isCode(name) { return .fileCode }
        return .file
    }

    /// Format a base64-encoded data length into a human-readable file size.
    /// Mirrors the logic in `ChatBubble.formattedFileSize(base64Length:)`.
    private func formattedFileSize(base64Length: Int) -> String {
        let bytes = base64Length * 3 / 4
        if bytes < 1024 { return "\(bytes) B" }
        let kb = Double(bytes) / 1024
        if kb < 1024 { return String(format: "%.1f KB", kb) }
        let mb = kb / 1024
        return String(format: "%.1f MB", mb)
    }

    // MARK: - Save

    /// Opens NSSavePanel to save the file attachment to disk.
    /// Reuses the same save logic as `ChatBubble.saveFileAttachment`.
    private func saveFileAttachment(_ attachment: ChatAttachment) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = (attachment.filename as NSString).lastPathComponent
        panel.canCreateDirectories = true

        let isLazy = attachment.isLazyLoad
        let attachmentId = attachment.id.isEmpty ? nil : attachment.id
        let base64 = attachment.data

        panel.begin { response in
            guard response == .OK, let destURL = panel.url else { return }
            if isLazy, let attachmentId {
                Task {
                    do {
                        let data = try await AttachmentContentClient.fetchContent(attachmentId: attachmentId)
                        try data.write(to: destURL)
                    } catch {
                        // Fetch failed
                    }
                }
            } else {
                guard let data = Data(base64Encoded: base64), !data.isEmpty else { return }
                DispatchQueue.global(qos: .userInitiated).async {
                    try? data.write(to: destURL)
                }
            }
        }
    }
}
