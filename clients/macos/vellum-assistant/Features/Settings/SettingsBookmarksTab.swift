import SwiftUI
import VellumAssistantShared

/// Settings tab that lists every bookmark in the workspace and lets the user
/// jump to or remove one. The view is intentionally not yet wired into
/// `SettingsPanel` — that lands in a follow-up PR — so this file compiles as
/// dead code today.
///
/// Visual conventions are borrowed from
/// ``SettingsArchivedConversationsTab`` (the empty-state + vCard list shell)
/// and ``SettingsSchedulesTab`` (the hover-driven expand/collapse pattern
/// that keeps the row compact until the user actually wants to read or act
/// on it).
struct SettingsBookmarksTab: View {
    @Bindable var bookmarkStore: BookmarkStore
    var conversationManager: ConversationManager
    var openMessage: (_ conversationId: String, _ daemonMessageId: String) -> Void
    var onClose: () -> Void

    @State private var hoveredBookmarkId: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if bookmarkStore.bookmarks.isEmpty {
                GeometryReader { geo in
                    VEmptyState(
                        title: "No bookmarks",
                        subtitle: "Hover any message and click the bookmark icon to save it here.",
                        icon: VIcon.bookmark.rawValue
                    )
                    .frame(width: geo.size.width, height: geo.size.height)
                }
                .frame(minHeight: 400)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(bookmarkStore.bookmarks.enumerated()), id: \.element.id) { index, bookmark in
                        if index > 0 {
                            SettingsDivider()
                        }
                        BookmarkRow(
                            bookmark: bookmark,
                            isExpanded: hoveredBookmarkId == bookmark.id,
                            onHover: { hovering in
                                if hovering {
                                    hoveredBookmarkId = bookmark.id
                                } else if hoveredBookmarkId == bookmark.id {
                                    hoveredBookmarkId = nil
                                }
                            },
                            onOpen: {
                                openMessage(bookmark.conversationId, bookmark.messageId)
                                onClose()
                            },
                            onRemove: {
                                Task {
                                    await bookmarkStore.toggle(
                                        messageId: bookmark.messageId,
                                        conversationId: bookmark.conversationId
                                    )
                                }
                            }
                        )
                    }
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .vCard()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task {
            await bookmarkStore.reload()
        }
    }
}

// MARK: - Bookmark Row

private struct BookmarkRow: View {
    let bookmark: BookmarkSummary
    let isExpanded: Bool
    let onHover: (Bool) -> Void
    let onOpen: () -> Void
    let onRemove: () -> Void

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return f
    }()

    private static let absoluteFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    private var roleAccentColor: Color {
        bookmark.messageRole == "assistant" ? VColor.primaryBase : VColor.contentTertiary
    }

    private var truncatedPreview: String {
        let preview = bookmark.messagePreview
        if preview.count <= 120 { return preview }
        return String(preview.prefix(120)) + "\u{2026}"
    }

    var body: some View {
        HStack(alignment: .top, spacing: VSpacing.md) {
            RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                .fill(roleAccentColor)
                .frame(width: 3)
                .frame(maxHeight: .infinity)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack(spacing: VSpacing.xs) {
                    Text(bookmark.conversationTitle ?? "Untitled")
                        .font(VFont.bodyMediumEmphasised)
                        .foregroundStyle(VColor.contentDefault)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text("\u{00B7} \(Self.relativeFormatter.localizedString(for: bookmark.createdAtDate, relativeTo: Date()))")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }

                if isExpanded {
                    Text(bookmark.messagePreview)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentDefault)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)

                    Text(
                        "Bookmarked \(Self.absoluteFormatter.string(from: bookmark.createdAtDate)) "
                        + "\u{00B7} Sent \(Self.absoluteFormatter.string(from: bookmark.messageCreatedAtDate))"
                    )
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                } else {
                    Text(truncatedPreview)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentDefault)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }

            Spacer(minLength: VSpacing.md)

            HStack(spacing: VSpacing.xs) {
                VButton(label: "Open", style: .outlined) {
                    onOpen()
                }
                VButton(
                    label: "Remove bookmark",
                    iconOnly: VIcon.x.rawValue,
                    style: .dangerGhost,
                    tooltip: "Remove bookmark"
                ) {
                    onRemove()
                }
            }
        }
        .padding(.vertical, VSpacing.sm)
        .contentShape(Rectangle())
        .onHover(perform: onHover)
        .animation(.easeInOut(duration: 0.2), value: isExpanded)
    }
}
