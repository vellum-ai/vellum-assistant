import SwiftUI
import VellumAssistantShared

struct ThreadSwitcherDrawer: View {
    let regularConversations: [ConversationModel]
    let activeConversationId: UUID?
    @ObservedObject var conversationManager: ConversationManager
    @ObservedObject var windowState: MainWindowState
    var sidebar: SidebarInteractionState
    let selectConversation: (ConversationModel) -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: SidebarLayoutMetrics.listRowGap) {
            Text("\(regularConversations.count) conversations")
                .font(VFont.caption)
                .foregroundColor(VColor.contentDisabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, VSpacing.lg)
                .padding(.top, VSpacing.sm)
                .padding(.bottom, VSpacing.xs)

            VColor.surfaceBase.frame(height: 1)
                .padding(.horizontal, VSpacing.xs)

            ForEach(regularConversations) { thread in
                SidebarThreadItem(
                    thread: thread,
                    conversationManager: conversationManager,
                    windowState: windowState,
                    sidebar: sidebar,
                    selectConversation: { selectConversation(thread) },
                    onSelect: onDismiss
                )
            }
        }
        .padding(VSpacing.sm)
        .fixedSize(horizontal: false, vertical: true)
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .shadow(color: VColor.auxBlack.opacity(0.1), radius: 1.5, x: 0, y: 1)
        .shadow(color: VColor.auxBlack.opacity(0.1), radius: 6, x: 0, y: 4)
        .onDisappear {
            if sidebar.isHoveredConversation != nil {
                sidebar.isHoveredConversation = nil
            }
            sidebar.conversationPendingDeletion = nil
        }
    }
}
