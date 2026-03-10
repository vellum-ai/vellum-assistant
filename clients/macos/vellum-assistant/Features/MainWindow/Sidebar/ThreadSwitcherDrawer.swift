import SwiftUI
import VellumAssistantShared

struct ThreadSwitcherDrawer: View {
    let regularThreads: [ThreadModel]
    let activeThreadId: UUID?
    @ObservedObject var threadManager: ThreadManager
    @ObservedObject var windowState: MainWindowState
    var sidebar: SidebarInteractionState
    let selectThread: (ThreadModel) -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Text("\(regularThreads.count) threads")
                .font(VFont.caption)
                .foregroundColor(VColor.tagText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, VSpacing.lg)
                .padding(.top, VSpacing.sm)
                .padding(.bottom, VSpacing.xs)

            VColor.surfaceBorder.frame(height: 1)
                .padding(.horizontal, VSpacing.xs)
                .padding(.bottom, VSpacing.xs)

            ForEach(regularThreads) { thread in
                SidebarThreadItem(
                    thread: thread,
                    threadManager: threadManager,
                    windowState: windowState,
                    sidebar: sidebar,
                    selectThread: { selectThread(thread) },
                    onSelect: onDismiss
                )
                .padding(.bottom, SidebarLayoutMetrics.listRowGap)
            }
        }
        .padding(.vertical, VSpacing.sm)
        .fixedSize(horizontal: false, vertical: true)
        .background(VColor.surfaceSubtle)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
        .onDisappear {
            if sidebar.isHoveredThread != nil {
                sidebar.isHoveredThread = nil
            }
            sidebar.threadPendingDeletion = nil
        }
    }
}
