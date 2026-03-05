import SwiftUI
import VellumAssistantShared

// MARK: - Interleaved Content

extension ChatBubble {
    /// Whether tool progress should be rendered inline at tool-call block positions
    /// instead of in the trailing status area.
    var shouldRenderToolProgressInline: Bool {
        guard !hideToolCalls else { return false }
        guard hasInterleavedContent else { return false }
        return message.contentOrder.contains(where: {
            if case .toolCall = $0 { return true }
            return false
        })
    }

    /// Whether this message has meaningful interleaved content (multiple block types).
    var hasInterleavedContent: Bool {
        // Use interleaved path when contentOrder has more than one distinct block type
        guard message.contentOrder.count > 1 else { return false }
        var hasTextBlock = false
        var hasNonText = false
        for ref in message.contentOrder {
            switch ref {
            case .text: hasTextBlock = true
            case .toolCall, .surface: hasNonText = true
            }
            if hasTextBlock && hasNonText { return true }
        }
        return false
    }

    /// Groups consecutive tool call refs for rendering.
    /// Hashable so ForEach can use stable identity based on content rather than
    /// array offset, which avoids spurious view invalidation when the array is
    /// recreated with identical values on each render pass.
    enum ContentGroup: Hashable {
        case texts([Int])
        case toolCalls([Int])
        case surface(Int)
    }

    func groupContentBlocks() -> [ContentGroup] {
        var groups: [ContentGroup] = []
        for ref in message.contentOrder {
            switch ref {
            case .text(let i):
                if case .texts(let indices) = groups.last {
                    groups[groups.count - 1] = .texts(indices + [i])
                } else {
                    groups.append(.texts([i]))
                }
            case .toolCall(let i):
                if case .toolCalls(let indices) = groups.last {
                    groups[groups.count - 1] = .toolCalls(indices + [i])
                } else {
                    groups.append(.toolCalls([i]))
                }
            case .surface(let i):
                groups.append(.surface(i))
            }
        }

        // When tool calls render inline (visible progress views), they must
        // break text runs just like surfaces do — skip coalescing entirely.
        guard !shouldRenderToolProgressInline else { return groups }

        // Post-process: coalesce text groups that are only separated by tool call
        // groups so that the user can drag-select across text that spans a tool
        // invocation (tool calls render as EmptyView and produce no visual gap).
        // Only .surface entries break a text run because they render visible content.
        var coalesced: [ContentGroup] = []
        var pendingTexts: [Int]?
        var pendingToolCalls: [ContentGroup] = []

        for group in groups {
            switch group {
            case .texts(let indices):
                if var existing = pendingTexts {
                    existing.append(contentsOf: indices)
                    pendingTexts = existing
                } else {
                    pendingTexts = indices
                }
            case .toolCalls:
                if pendingTexts != nil {
                    // Buffer the tool calls; they might sit between two text groups.
                    pendingToolCalls.append(group)
                } else {
                    coalesced.append(group)
                }
            case .surface:
                // A surface breaks the text run — flush pending state.
                if let texts = pendingTexts {
                    coalesced.append(.texts(texts))
                    coalesced.append(contentsOf: pendingToolCalls)
                    pendingTexts = nil
                    pendingToolCalls = []
                }
                coalesced.append(group)
            }
        }

        // Flush any remaining pending state.
        if let texts = pendingTexts {
            coalesced.append(.texts(texts))
            coalesced.append(contentsOf: pendingToolCalls)
        }

        return coalesced
    }

    /// Returns true when there is non-empty text content after a tool-call group.
    /// Used to decide whether the inline progress block should remain in
    /// an active "thinking/processing" phase while the model continues.
    private func hasTextAfterToolGroup(_ toolIndices: [Int]) -> Bool {
        let indexSet = Set(toolIndices)
        guard let lastToolRefIndex = message.contentOrder.lastIndex(where: {
            if case .toolCall(let i) = $0 { return indexSet.contains(i) }
            return false
        }) else {
            return hasText
        }
        let start = message.contentOrder.index(after: lastToolRefIndex)
        guard start < message.contentOrder.endIndex else { return false }
        for ref in message.contentOrder[start...] {
            guard case .text(let textIndex) = ref,
                  textIndex >= 0,
                  textIndex < message.textSegments.count else { continue }
            if !message.textSegments[textIndex].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return true
            }
        }
        return false
    }

    @ViewBuilder
    private func inlineToolProgress(toolIndices: [Int], isLatestGroup: Bool) -> some View {
        let groupedToolCalls: [ToolCallData] = toolIndices.compactMap { idx -> ToolCallData? in
            guard idx < message.toolCalls.count else { return nil }
            return message.toolCalls[idx]
        }
        if !groupedToolCalls.isEmpty {
            AssistantProgressView(
                toolCalls: groupedToolCalls,
                isStreaming: isLatestGroup ? message.isStreaming : false,
                hasText: hasTextAfterToolGroup(toolIndices),
                isProcessing: isLatestGroup && isProcessingAfterTools,
                processingStatusText: isLatestGroup && isProcessingAfterTools ? processingStatusText : nil,
                streamingCodePreview: isLatestGroup ? message.streamingCodePreview : nil,
                streamingCodeToolName: isLatestGroup ? message.streamingCodeToolName : nil,
                decidedConfirmation: isLatestGroup ? decidedConfirmation : nil,
                onRehydrate: onRehydrate
            )
            .frame(maxWidth: 520, alignment: .leading)
        }
    }

    @ViewBuilder
    var interleavedContent: some View {
        let groups = groupContentBlocks()
        let latestToolGroup: [Int]? = groups.reversed().compactMap { group in
            guard case .toolCalls(let indices) = group else { return nil }
            return indices
        }.first

        // Render all content groups in order: text, tool calls, and surfaces.
        // Uses \.self identity (backed by Hashable conformance) instead of
        // \.offset so SwiftUI can skip re-evaluating children whose content
        // hasn't changed — prevents a view-update death spiral on long
        // conversations with many interleaved blocks.
        ForEach(groups, id: \.self) { group in
            switch group {
            case .texts(let indices):
                let joined = indices
                    .compactMap { i in
                        i < message.textSegments.count
                            ? message.textSegments[i].trimmingCharacters(in: .whitespacesAndNewlines)
                            : nil
                    }
                    .filter { !$0.isEmpty }
                    .joined(separator: "\n")
                if !joined.isEmpty {
                    textBubble(for: joined)
                }
            case .toolCalls(let indices):
                if shouldRenderToolProgressInline {
                    inlineToolProgress(toolIndices: indices, isLatestGroup: indices == latestToolGroup)
                } else {
                    // Tool calls are rendered by trailingStatus below the message
                    EmptyView()
                }
            case .surface(let i):
                if i < message.inlineSurfaces.count,
                   message.inlineSurfaces[i].id != activeSurfaceId {
                    InlineSurfaceRouter(surface: message.inlineSurfaces[i], onAction: onSurfaceAction, onRefetch: onSurfaceRefetch)
                }
            }
        }

        // Attachments are not part of contentOrder but must still be rendered
        let partitioned = partitionedAttachments
        if !partitioned.images.isEmpty {
            attachmentImageGrid(partitioned.images)
        }
        if !partitioned.videos.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(partitioned.videos) { attachment in
                    InlineVideoAttachmentView(attachment: attachment, resolveHttpPort: resolveHttpPort)
                }
            }
        }
        if !partitioned.files.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                ForEach(partitioned.files) { attachment in
                    fileAttachmentChip(attachment)
                }
            }
        }
    }
}
