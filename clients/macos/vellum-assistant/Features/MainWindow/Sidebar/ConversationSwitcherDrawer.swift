import SwiftUI
import VellumAssistantShared

struct ConversationSwitcherDrawer: View {
    @ObservedObject var conversationManager: ConversationManager
    @ObservedObject var windowState: MainWindowState
    var sidebar: SidebarInteractionState
    var customGroupsEnabled: Bool = false
    var backgroundEnabled: Bool = false
    let selectConversation: (ConversationModel) -> Void
    let onDismiss: () -> Void

    /// Max conversations shown per section before "Show more".
    private let maxPerSection = 5

    /// Tracks which sections have been expanded via "Show more".
    @State private var expandedSections: Set<String> = []

    /// Group entries filtered by flags: custom groups and Background merged into ungrouped when their flags are off.
    private var drawerEntries: [(group: ConversationGroup?, conversations: [ConversationModel])] {
        let raw = conversationManager.groupedConversations
        var entries: [(ConversationGroup?, [ConversationModel])] = []
        var extraUngrouped: [ConversationModel] = []
        for entry in raw {
            if let group = entry.group {
                if group.id == ConversationGroup.background.id && !backgroundEnabled {
                    extraUngrouped.append(contentsOf: entry.conversations)
                } else if !group.isSystemGroup && !customGroupsEnabled {
                    extraUngrouped.append(contentsOf: entry.conversations)
                } else {
                    entries.append(entry)
                }
            } else {
                extraUngrouped.append(contentsOf: entry.conversations)
            }
        }
        entries.append((nil, extraUngrouped))
        return entries
    }
    /// Measured content height for size-to-fit behavior.
    @State private var contentHeight: CGFloat = 0

    private func isConversationSelected(_ conversation: ConversationModel) -> Bool {
        switch windowState.selection {
        case .panel:
            return false
        case .conversation(let id):
            return id == conversation.id
        case .appEditing(_, let conversationId):
            return conversationId == conversation.id
        case .app, .none:
            return conversation.id == windowState.persistentConversationId
        }
    }

    private func makeRow(_ conversation: ConversationModel) -> SidebarConversationItem {
        SidebarConversationItem(
            conversation: conversation,
            isSelected: isConversationSelected(conversation),
            interactionState: conversationManager.interactionState(for: conversation.id),
            selectConversation: { selectConversation(conversation) },
            onSelect: onDismiss,
            onTogglePin: {
                withAnimation(VAnimation.standard) {
                    if conversation.isPinned {
                        conversationManager.unpinConversation(id: conversation.id)
                    } else {
                        conversationManager.pinConversation(id: conversation.id)
                    }
                }
            },
            onArchive: { conversationManager.archiveConversation(id: conversation.id) },
            onStartRename: {
                sidebar.renamingConversationId = conversation.id
                sidebar.renameText = conversation.title
            },
            onMarkUnread: { conversationManager.markConversationUnread(conversationId: conversation.id) },
            onDragStart: {
                sidebar.beginConversationDrag(conversation.id)
            },
            onOpenInNewWindow: conversation.conversationId != nil ? {
                AppDelegate.shared?.threadWindowManager?.openThread(
                    conversationLocalId: conversation.id,
                    conversationManager: conversationManager
                )
            } : nil,
            onShowFeedback: conversation.conversationId != nil && !LogExporter.isManagedAssistant ? {
                AppDelegate.shared?.showLogReportWindow(scope: .conversation(conversationId: conversation.conversationId!, conversationTitle: conversation.title))
            } : nil
        )
    }

    var body: some View {
        GeometryReader { geo in
            let maxHeight = geo.size.height * 0.75
            let isScrollable = contentHeight > maxHeight

            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(drawerEntries.indices, id: \.self) { index in
                        let entry = drawerEntries[index]
                        let sectionId = entry.group?.id ?? "ungrouped"
                        let conversations = entry.conversations
                        let isExpanded = expandedSections.contains(sectionId)

                        if !conversations.isEmpty {
                            if index > 0 {
                                VMenuDivider()
                            }
                            sectionContent(
                                sectionId: sectionId,
                                title: entry.group?.name ?? "Conversations",
                                conversations: conversations,
                                isExpanded: isExpanded
                            )
                        }
                    }
                }
                .background(GeometryReader { contentGeo in
                    Color.clear.preference(
                        key: DrawerContentHeightKey.self,
                        value: contentGeo.size.height + VSpacing.sm * 2
                    )
                })
            }
            .onPreferenceChange(DrawerContentHeightKey.self) { contentHeight = $0 }
            .scrollBounceBehavior(.basedOnSize)
            .padding(VSpacing.sm)
            .frame(height: min(contentHeight, maxHeight))
            .background(VColor.surfaceLift)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
            .shadow(color: VColor.auxBlack.opacity(0.1), radius: 1.5, x: 0, y: 1)
            .shadow(color: VColor.auxBlack.opacity(0.1), radius: 6, x: 0, y: 4)
            .overlay(alignment: .bottom) {
                if isScrollable {
                    LinearGradient(
                        colors: [VColor.surfaceLift.opacity(0), VColor.surfaceLift],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .frame(height: 28)
                    .clipShape(UnevenRoundedRectangle(
                        bottomLeadingRadius: VRadius.lg,
                        bottomTrailingRadius: VRadius.lg
                    ))
                    .allowsHitTesting(false)
                }
            }
        }
    }

    @ViewBuilder
    private func sectionContent(
        sectionId: String,
        title: String,
        conversations: [ConversationModel],
        isExpanded: Bool
    ) -> some View {
        HStack {
            Text(title)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
            Spacer()
            Text("\(conversations.count)")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.top, VSpacing.xs)

        let displayed = isExpanded ? conversations : Array(conversations.prefix(maxPerSection))
        ForEach(displayed) { conversation in
            makeRow(conversation)
                .equatable()
                .id(ConversationRowIdentity(conversationId: conversation.id, groupId: conversation.groupId))
        }

        if conversations.count > maxPerSection {
            HStack {
                VButton(
                    label: isExpanded ? "Show less" : "Show more (\(conversations.count - maxPerSection))",
                    style: .ghost,
                    size: .compact
                ) {
                    withAnimation(VAnimation.fast) {
                        if isExpanded {
                            expandedSections.remove(sectionId)
                        } else {
                            expandedSections.insert(sectionId)
                        }
                    }
                }
                Spacer()
            }
            .padding(.leading, VSpacing.sm)
        }
    }
}

private struct DrawerContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
