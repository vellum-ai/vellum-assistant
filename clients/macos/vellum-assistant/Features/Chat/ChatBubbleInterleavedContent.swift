import SwiftUI
import VellumAssistantShared

// MARK: - Interleaved Content

extension ChatBubble {
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
        return groups
    }

    @ViewBuilder
    var interleavedContent: some View {
        let groups = groupContentBlocks()

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
            case .toolCalls:
                // Tool calls are rendered by trailingStatus below the message
                EmptyView()
            case .surface(let i):
                if i < message.inlineSurfaces.count,
                   message.inlineSurfaces[i].id != activeSurfaceId {
                    InlineSurfaceRouter(surface: message.inlineSurfaces[i], onAction: onSurfaceAction)
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
