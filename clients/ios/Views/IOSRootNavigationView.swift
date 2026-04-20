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
    @State private var dragTranslation: CGFloat = 0

    /// Width of the drawer — capped so the underlying chat still peeks through.
    private let drawerMaxWidth: CGFloat = 360

    var body: some View {
        Group {
            if horizontalSizeClass == .compact {
                compactLayout
            } else {
                regularLayout
            }
        }
        .sheet(isPresented: $isSettingsPresented) {
            SettingsBottomSheet(
                authManager: authManager,
                navigateToConnect: $navigateToConnect,
                conversationStore: store
            )
        }
        .task {
            seedActiveConversationIfNeeded()
            applyPendingSelectionRequestIfNeeded()
        }
        .onChange(of: store.selectionRequest?.id) { _, _ in
            applyPendingSelectionRequestIfNeeded()
        }
        .onChange(of: store.conversations.map(\.id)) { _, _ in
            seedActiveConversationIfNeeded()
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
                    onShowSettings: {
                        closeDrawer()
                        // Delay slightly so the drawer's dismissal animation
                        // can start before the sheet animation begins.
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                            isSettingsPresented = true
                        }
                    },
                    onClose: closeDrawer
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
                onComposeNew: composeNewConversation
            )
            .task(id: id) {
                store.loadHistoryIfNeeded(for: id)
                store.markConversationSeenIfNeeded(conversationLocalId: id, isExplicitOpen: true)
                store.viewModel(for: id).consumeDeepLinkIfNeeded()
            }
            .onChange(of: conversation.hasUnseenLatestAssistantMessage) { _, hasUnseen in
                guard hasUnseen else { return }
                store.markConversationSeenIfNeeded(conversationLocalId: id)
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
                .accessibilityHint("Opens the conversation menu")
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                Button(action: composeNewConversation) {
                    VIconView(.squarePen, size: 20)
                }
                .accessibilityLabel("New chat")
            }
        }
    }

    // MARK: - Regular (iPad)

    private var regularLayout: some View {
        ConversationListView(
            store: store,
            onShowSettings: { isSettingsPresented = true }
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
        activeConversationId = id
        closeDrawer()
    }

    private func composeNewConversation() {
        let conversation = store.newConversation()
        activeConversationId = conversation.id
        closeDrawer()
    }

    // MARK: - Selection request handling

    private func seedActiveConversationIfNeeded() {
        guard activeConversationId == nil else { return }
        activeConversationId = store.conversations
            .first(where: { !$0.isArchived && !$0.isPrivate })?.id
    }

    private func applyPendingSelectionRequestIfNeeded() {
        guard let request = store.selectionRequest else { return }
        if horizontalSizeClass == .compact {
            activeConversationId = request.conversationLocalId
            closeDrawer()
            store.consumeSelectionRequest(id: request.id)
        }
        // On regular (iPad) size classes, ConversationListView's own
        // NavigationSplitView consumes the selection request. Leave it alone
        // so the request isn't double-consumed.
    }
}
#endif
