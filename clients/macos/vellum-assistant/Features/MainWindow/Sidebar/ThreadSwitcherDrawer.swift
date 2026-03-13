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
        VStack(spacing: SidebarLayoutMetrics.listRowGap) {
            Text("\(regularThreads.count) threads")
                .font(VFont.caption)
                .foregroundColor(VColor.contentDisabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, VSpacing.lg)
                .padding(.top, VSpacing.sm)
                .padding(.bottom, VSpacing.xs)

            VColor.surfaceBase.frame(height: 1)
                .padding(.horizontal, VSpacing.xs)

            ForEach(regularThreads) { thread in
                SidebarThreadItem(
                    thread: thread,
                    threadManager: threadManager,
                    windowState: windowState,
                    sidebar: sidebar,
                    selectThread: { selectThread(thread) },
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
            if sidebar.isHoveredThread != nil {
                sidebar.isHoveredThread = nil
            }
            sidebar.threadPendingDeletion = nil
        }
    }
}
