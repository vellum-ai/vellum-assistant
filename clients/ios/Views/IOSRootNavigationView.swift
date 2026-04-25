#if canImport(UIKit)
import SwiftUI
import UIKit
import VellumAssistantShared

/// Root navigation surface for the iOS app.
///
/// Replaces the previous `TabView` with a size-class-aware layout:
///
/// - **Compact (iPhone)**: a single `NavigationStack` that shows the active
///   conversation's chat view. A slide-in drawer overlays the conversation
///   list, and Settings is presented as a bottom sheet. The drawer and sheet
///   are the only switchers on compact — there is no persistent tab bar.
/// - **Regular (iPad)**: the existing `NavigationSplitView` sidebar layout is
///   preserved via `ConversationListView`; Settings is presented as a sheet
///   from the sidebar toolbar.
///
/// Apple references consulted (2026-04-20):
/// - Human Interface Guidelines — [Navigation](https://developer.apple.com/design/human-interface-guidelines/navigation)
///   (side-menu / hamburger pattern: use when content categories are numerous
///   or unequal, with an always-accessible primary surface)
/// - Human Interface Guidelines — [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)
/// - [`NavigationStack`](https://developer.apple.com/documentation/swiftui/navigationstack) /
///   [`NavigationSplitView`](https://developer.apple.com/documentation/swiftui/navigationsplitview)
/// - [`presentationDetents(_:)`](https://developer.apple.com/documentation/swiftui/view/presentationdetents(_:)) (iOS 16+)
struct IOSRootNavigationView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Bindable var authManager: AuthManager
    @ObservedObject var store: IOSConversationStore
    @Binding var navigateToConnect: Bool

    @State private var isDrawerOpen: Bool = false
    @State private var isSettingsPresented: Bool = false
    @State private var activeConversationId: UUID?
    /// True when `activeConversationId` was populated by the auto-seed path
    /// (cold start / size-class transition / fallback after deletion) rather
    /// than by an explicit user action. `compactRoot`'s `.task(id:)` uses
    /// this to decide whether to mark the conversation as seen: we must not
    /// silently clear unread state or override a pending `.unread` attention
    /// signal on a conversation the user never explicitly opened.
    @State private var activeConversationWasSeeded: Bool = false
    @State private var dragTranslation: CGFloat = 0

    /// Width of the drawer — capped so the underlying chat still peeks through.
    private let drawerMaxWidth: CGFloat = 360

    var body: some View {
        Group {
            // Treat a `nil` size class as compact so that on iPhone cold start —
            // where SwiftUI may report `horizontalSizeClass` as `nil` for one
            // frame during initial environment resolution — we don't briefly
            // mount `regularLayout` (i.e. `ConversationListView`). Its
            // `.onAppear` consumes any pending selection request synchronously
            // during layout, which would otherwise land a cold-start push-
            // notification deep link in a transient `ConversationListView` that
            // is immediately torn down when the size class resolves to
            // `.compact`, silently dropping the selection.
            if horizontalSizeClass == .regular {
                regularLayout
            } else {
                compactLayout
            }
        }
        // `onDismiss` resets `navigateToConnect` so that:
        // (1) re-opening Settings via the drawer/toolbar doesn't auto-push
        //     the Connect destination again, and
        // (2) if `IOSRootNavigationView` is recreated (e.g. `ContentView`'s
        //     `.id(client)` changes), `@State isSettingsPresented` resets to
        //     `false` but the parent-owned `navigateToConnect` stays `true` —
        //     which would otherwise cause the `.task` one-shot check below to
        //     reopen the sheet automatically. Clearing the binding on dismiss
        //     breaks that loop.
        .sheet(isPresented: $isSettingsPresented, onDismiss: {
            navigateToConnect = false
        }) {
            SettingsBottomSheet(
                authManager: authManager,
                conversationStore: store
            )
        }
        .task {
            seedActiveConversationIfNeeded()
            applyPendingSelectionRequestIfNeeded()
            // Catch the case where `navigateToConnect` was already `true` before
            // this view mounted (e.g. from `ContentView.connectionFailedView`).
            // `.onChange` only fires on subsequent mutations, so a one-shot
            // check here ensures the Settings sheet still opens in that flow.
            if navigateToConnect && !isSettingsPresented {
                isSettingsPresented = true
            }
        }
        .onChange(of: store.selectionRequest?.id) { _, _ in
            applyPendingSelectionRequestIfNeeded()
        }
        .onChange(of: store.conversations.map(\.id)) { _, _ in
            // Seeds when no conversation is active AND reselects when the
            // currently active one has been deleted from the store.
            reconcileActiveConversation()
        }
        .onChange(of: horizontalSizeClass) { _, newValue in
            // Re-attempt the compact-only seed on size-class transitions
            // (rotation, Split View collapse). Without this, an iPad session
            // that started on `.regular` with no selection would drop into
            // `compactRoot`'s empty state when the size class flips to
            // `.compact` until the user opens the drawer to pick a chat.
            if newValue == .compact {
                seedActiveConversationIfNeeded()
            } else if newValue == .regular {
                // Reset drawer state when transitioning to regular — the drawer
                // isn't rendered on iPad, but `@State` would otherwise preserve
                // `isDrawerOpen = true` across the transition and cause the
                // drawer to reappear already-open if the user later flips back
                // to compact (e.g. resizing Split View on iPad).
                isDrawerOpen = false
                dragTranslation = 0
            }
        }
        // Triggered from `ContentView.connectionFailedView` ("Go to Settings")
        // and anywhere else that wants to push the Connect screen. Since the
        // Settings screen now lives inside a sheet, the sheet must be presented
        // first for the `.navigationDestination(isPresented:)` inside
        // `SettingsView` to have a containing navigation stack to drive.
        .onChange(of: navigateToConnect) { _, shouldShow in
            if shouldShow && !isSettingsPresented {
                isSettingsPresented = true
            }
        }
    }

    // MARK: - Compact (iPhone)

    private var compactLayout: some View {
        GeometryReader { proxy in
            let drawerWidth = min(proxy.size.width * 0.85, drawerMaxWidth)
            let offset = drawerOffset(drawerWidth: drawerWidth)

            ZStack(alignment: .leading) {
                NavigationStack {
                    compactRoot
                }
                .disabled(isDrawerOpen)
                .accessibilityHidden(isDrawerOpen)

                dimmingOverlay
                    .opacity(dimmingOpacity(drawerWidth: drawerWidth))
                    .allowsHitTesting(isDrawerOpen)
                    .onTapGesture { closeDrawer() }

                ConversationDrawerView(
                    store: store,
                    onSelectConversation: selectConversation,
                    onClose: closeDrawer,
                    onArchiveActiveConversation: handleArchiveActiveConversation,
                    activeConversationId: $activeConversationId
                )
                .frame(width: drawerWidth)
                .offset(x: -drawerWidth + offset)
                .accessibilityHidden(!isDrawerOpen)
            }
            .animation(.interactiveSpring(response: 0.35, dampingFraction: 0.85), value: isDrawerOpen)
            .animation(.interactiveSpring(response: 0.35, dampingFraction: 0.85), value: dragTranslation)
            .simultaneousGesture(edgeDragGesture(drawerWidth: drawerWidth))
        }
    }

    private var dimmingOverlay: some View {
        Color.black.opacity(0.4)
            .ignoresSafeArea()
            .accessibilityHidden(true)
    }

    /// How far the drawer is translated from its fully-closed position (0 = closed, drawerWidth = fully open).
    private func drawerOffset(drawerWidth: CGFloat) -> CGFloat {
        let base: CGFloat = isDrawerOpen ? drawerWidth : 0
        let withDrag = base + dragTranslation
        return min(max(withDrag, 0), drawerWidth)
    }

    private func dimmingOpacity(drawerWidth: CGFloat) -> Double {
        guard drawerWidth > 0 else { return 0 }
        return Double(drawerOffset(drawerWidth: drawerWidth) / drawerWidth)
    }

    private func edgeDragGesture(drawerWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                if isDrawerOpen {
                    // Only track leftward drags when already open.
                    dragTranslation = min(0, value.translation.width)
                } else if value.startLocation.x < 24 {
                    // Only track edge-initiated drags when closed.
                    dragTranslation = max(0, value.translation.width)
                }
            }
            .onEnded { value in
                defer { dragTranslation = 0 }
                let projected = value.predictedEndTranslation.width
                if isDrawerOpen {
                    if projected < -drawerWidth / 3 {
                        isDrawerOpen = false
                    }
                } else if value.startLocation.x < 24 && projected > drawerWidth / 3 {
                    isDrawerOpen = true
                }
            }
    }

    @ViewBuilder
    private var compactRoot: some View {
        if let id = activeConversationId,
           let conversation = store.conversations.first(where: { $0.id == id }) {
            ConversationChatView(
                viewModel: store.viewModel(for: id),
                store: store,
                conversation: conversation,
                onOpenDrawer: openDrawer,
                onComposeNew: composeNewConversation,
                onShowSettings: { isSettingsPresented = true }
            )
            .task(id: id) {
                store.loadHistoryIfNeeded(for: id)
                // Only mark the conversation as seen when the detail was
                // mounted by an explicit user action (drawer tap, compose,
                // selection request). The seed path populates
                // `activeConversationId` on cold start / size-class
                // transitions without user involvement, and marking-seen
                // there would silently clear unread state and any pending
                // `.unread` attention override on every launch.
                if !activeConversationWasSeeded {
                    store.markConversationSeenIfNeeded(conversationLocalId: id, isExplicitOpen: true)
                }
                store.viewModel(for: id).consumeDeepLinkIfNeeded()
            }
            .onChange(of: conversation.hasUnseenLatestAssistantMessage) { _, hasUnseen in
                guard hasUnseen else { return }
                store.markConversationSeenIfNeeded(conversationLocalId: id)
            }
            // Hot-path deep links: URL events that arrive while the chat is
            // already on-screen. Cold-start deep links are picked up via the
            // `.task(id:)` above. Matches the iPad NavigationSplitView detail
            // path in `ConversationListView.conversationDetailContent(for:)`.
            .onOpenURL { _ in
                Task { @MainActor in
                    store.viewModel(for: id).consumeDeepLinkIfNeeded()
                }
            }
        } else {
            compactEmptyRoot
        }
    }

    private var compactEmptyRoot: some View {
        VStack(spacing: VSpacing.lg) {
            VIconView(.messageSquare, size: 48)
                .foregroundStyle(VColor.contentTertiary)
                .accessibilityHidden(true)
            Text("No chats yet")
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentDefault)
            Text("Start a new conversation to begin.")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
            Button(action: composeNewConversation) {
                Label { Text("New Chat") } icon: { VIconView(.squarePen, size: 16) }
            }
            .buttonStyle(.borderedProminent)
            .tint(VColor.primaryBase)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button(action: openDrawer) {
                    VIconView(.panelLeft, size: 20)
                }
                .accessibilityLabel("Chats")
            }
            .hideSharedToolbarBackgroundIfAvailable()
            ToolbarItem(placement: .navigationBarLeading) {
                Button(action: { isSettingsPresented = true }) {
                    VIconView(.settings, size: 20)
                }
                .accessibilityLabel("Settings")
            }
            .hideSharedToolbarBackgroundIfAvailable()
            ToolbarItem(placement: .navigationBarTrailing) {
                Button(action: composeNewConversation) {
                    VIconView(.squarePen, size: 20)
                }
                .accessibilityLabel("New chat")
            }
            .hideSharedToolbarBackgroundIfAvailable()
        }
    }

    // MARK: - Regular (iPad)

    private var regularLayout: some View {
        ConversationListView(
            store: store,
            onShowSettings: { isSettingsPresented = true },
            selectedConversationId: $activeConversationId
        )
    }

    // MARK: - Actions

    private func openDrawer() {
        UIAccessibility.post(notification: .announcement, argument: "Conversation menu opened")
        isDrawerOpen = true
    }

    private func closeDrawer() {
        isDrawerOpen = false
    }

    private func selectConversation(_ id: UUID) {
        let wasAlreadyActive = (activeConversationId == id)
        activeConversationWasSeeded = false
        activeConversationId = id
        closeDrawer()
        if wasAlreadyActive {
            // `.task(id:)` won't refire because `id` is unchanged, so mark
            // seen explicitly — this path matters when the user taps the
            // currently-seeded conversation in the drawer and expects its
            // unread badge to clear.
            store.markConversationSeenIfNeeded(conversationLocalId: id, isExplicitOpen: true)
        }
    }

    private func composeNewConversation() {
        let conversation = store.newConversation()
        activeConversationWasSeeded = false
        activeConversationId = conversation.id
        closeDrawer()
    }

    /// Fallback after the user archives the currently active conversation from
    /// the drawer. Marks the replacement as *seeded* — the user didn't
    /// explicitly open it — so `compactRoot`'s `.task(id:)` does not silently
    /// clear its unread badge or override a pending `.unread` attention
    /// signal. Mirrors the seeding discipline used by
    /// `seedActiveConversationIfNeeded` and `reconcileActiveConversation`.
    private func handleArchiveActiveConversation() {
        activeConversationWasSeeded = true
        activeConversationId = firstSelectableConversationId()
    }

    // MARK: - Selection request handling

    /// Seeds `activeConversationId` with the first eligible conversation when
    /// nothing is selected yet — but only on compact. iPad's
    /// `NavigationSplitView` starts with an empty detail pane until the user
    /// explicitly taps a conversation in the sidebar, and auto-selecting on
    /// launch would mount the first conversation's detail view unbidden. That
    /// detail view's task calls `markConversationSeenIfNeeded(...,
    /// isExplicitOpen: true)`, which would silently clear unread state /
    /// attention signals on every launch/reconnect for iPad users. Compact
    /// needs the seed because `compactRoot` falls back to an empty-state view
    /// when there is no active conversation.
    private func seedActiveConversationIfNeeded() {
        guard horizontalSizeClass != .regular, activeConversationId == nil else { return }
        guard let seed = firstSelectableConversationId() else { return }
        activeConversationWasSeeded = true
        activeConversationId = seed
    }

    /// Ensures `activeConversationId` points at a conversation that is still
    /// in the store. Handles three cases on a store update:
    /// 1. No active selection yet — seed the first eligible conversation.
    /// 2. Active selection still resolves — leave it alone, even if the
    ///    conversation is archived. The drawer surfaces archived
    ///    conversations in a DisclosureGroup, so a user can legitimately
    ///    select one and we shouldn't kick them out on the next store change.
    /// 3. Active selection was removed from the store entirely — fall back to
    ///    the first eligible conversation, or clear the selection so
    ///    `compactRoot` shows the empty state.
    private func reconcileActiveConversation() {
        guard let id = activeConversationId else {
            seedActiveConversationIfNeeded()
            return
        }
        let stillExists = store.conversations.contains { $0.id == id }
        if !stillExists {
            // Not a user-initiated open — the previously active conversation
            // was deleted out from under us. Treat the fallback as a seed so
            // `compactRoot`'s `.task(id:)` won't auto-mark-seen.
            activeConversationWasSeeded = true
            activeConversationId = firstSelectableConversationId()
        }
    }

    /// Excludes the synthetic loading placeholder (`IOSConversationStore`
    /// inserts a single `IOSConversation()` with `conversationId == nil`
    /// while `isLoadingInitialConversations` is true). That placeholder has
    /// no daemon-side identity; seeding it would mount a chat view that
    /// cannot load history and would get thrown away as soon as the first
    /// real conversation list response arrives.
    private func firstSelectableConversationId() -> UUID? {
        store.conversations.first(where: {
            $0.conversationId != nil && !$0.isArchived
        })?.id
    }

    private func applyPendingSelectionRequestIfNeeded() {
        guard let request = store.selectionRequest else { return }
        // A selection request is always a jump-to-chat intent (push
        // notification tap, fork navigation, etc.). Dismiss the Settings sheet
        // if it's up so the user actually sees the target conversation
        // instead of remaining behind the modal. This applies to both size
        // classes — the sheet is owned by this view and covers the sidebar on
        // iPad just as it covers the chat on iPhone.
        if isSettingsPresented {
            isSettingsPresented = false
        }
        // Consume the request at this single site regardless of size class.
        // `activeConversationId` is the source of truth both for `compactRoot`
        // and for `ConversationListView.selectedConversationId` (via binding),
        // so writing it here drives both layouts. Centralizing the consume
        // avoids a dual-observer race where the child would `consume` (nil'ing
        // `store.selectionRequest`) before this handler could dismiss the
        // Settings sheet, which would leave the target chat stranded behind
        // the modal on iPad.
        let wasAlreadyActive = (activeConversationId == request.conversationLocalId)
        activeConversationWasSeeded = false
        activeConversationId = request.conversationLocalId
        closeDrawer()
        if wasAlreadyActive {
            // Same-id requests (e.g. re-tapping the push for the
            // currently-active chat) won't retrigger `.task(id:)`; mark seen
            // here so the explicit intent still clears unread state.
            store.markConversationSeenIfNeeded(
                conversationLocalId: request.conversationLocalId,
                isExplicitOpen: true
            )
        }
        store.consumeSelectionRequest(id: request.id)
    }
}
#endif
