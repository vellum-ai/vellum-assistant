import SwiftUI
import VellumAssistantShared
import Foundation
import UserNotifications
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ConversationManager")

// MARK: - Conversation Client Protocol

/// Abstraction for direct conversation mutations, decoupled from GatewayConnectionManager.
@MainActor
protocol ConversationClientProtocol {
    func deleteConversation(_ conversationId: String) async
    func archiveConversation(_ conversationId: String) async
    func unarchiveConversation(_ conversationId: String) async
}

/// Gateway-backed conversation mutation client.
@MainActor
struct ConversationClient: ConversationClientProtocol {
    nonisolated init() {}

    func deleteConversation(_ conversationId: String) async {
        let response = try? await GatewayHTTPClient.delete(
            path: "assistants/{assistantId}/conversations/\(conversationId)", timeout: 10
        )
        if let statusCode = response?.statusCode, !(200..<300).contains(statusCode) {
            log.error("Delete conversation \(conversationId) failed (HTTP \(statusCode))")
        }
    }

    func archiveConversation(_ conversationId: String) async {
        let response = try? await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/conversations/\(conversationId)/archive", timeout: 10
        )
        if let statusCode = response?.statusCode, !(200..<300).contains(statusCode) {
            log.error("Archive conversation \(conversationId) failed (HTTP \(statusCode))")
        }
    }

    func unarchiveConversation(_ conversationId: String) async {
        let response = try? await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/conversations/\(conversationId)/unarchive", timeout: 10
        )
        if let statusCode = response?.statusCode, !(200..<300).contains(statusCode) {
            log.error("Unarchive conversation \(conversationId) failed (HTTP \(statusCode))")
        }
    }
}

/// Thin facade wiring `ConversationListStore`, `ConversationSelectionStore`, and
/// `ConversationActivityStore` together with app-layer dependencies (daemon connection,
/// fork/detail clients, conversation restorer).
///
/// Views continue to inject `ConversationManager` via `@Environment`, but the manager
/// itself holds no conversation-list or selection state — it delegates to the focused
/// stores. Cross-cutting operations (fork, archive, background-conversation creation)
/// that touch multiple stores live here.
///
/// Reference: [Managing model data in your app](https://developer.apple.com/documentation/swiftui/managing-model-data-in-your-app)
@Observable
@MainActor
final class ConversationManager: ConversationRestorerDelegate {

    // MARK: - Stores

    let listStore = ConversationListStore()
    let selectionStore: ConversationSelectionStore
    let activityStore = ConversationActivityStore()

    // MARK: - App-Layer Dependencies

    private let connectionManager: GatewayConnectionManager
    private let eventStreamClient: EventStreamClient
    private let conversationClient: ConversationClientProtocol
    private let conversationForkClient: any ConversationForkClientProtocol
    private let conversationDetailClient: any ConversationDetailClientProtocol
    private let conversationInferenceProfileClient: any ConversationInferenceProfileClientProtocol
    private let conversationAnalysisClient: ConversationAnalysisClientProtocol
    private let conversationRestorer: ConversationRestorer
    private let acpSessionStore: ACPSessionStore?

    // MARK: - Pre-Chat Onboarding

    /// Pre-chat onboarding context from the onboarding flow. Set by AppDelegate
    /// on first launch; consumed by the first draft ChatViewModel so the first
    /// message POST includes it for assistant personalization.
    var preChatContext: PreChatOnboardingContext?

    // MARK: - Notification Catch-Up

    /// Daemon conversation IDs that need a notification catch-up (history fetch)
    /// once the associated ChatViewModel finishes its current send/think cycle.
    @ObservationIgnored private var pendingNotificationCatchUpIds: Set<String> = []

    // MARK: - App-Layer Callbacks

    /// Called when the user responds to a confirmation via the inline chat UI.
    var onInlineConfirmationResponse: ((String, String) -> Void)?

    /// The ambient agent instance, set by the app layer so watch session callbacks
    /// can create and manage WatchSession objects.
    weak var ambientAgent: AmbientAgent?

    // MARK: - Forwarded Properties (ConversationRestorerDelegate + View Compatibility)

    var conversations: [ConversationModel] {
        get { listStore.conversations }
        set { listStore.conversations = newValue }
    }

    var groups: [ConversationGroup] {
        get { listStore.groups }
        set { listStore.groups = newValue }
    }

    var daemonSupportsGroups: Bool {
        get { listStore.daemonSupportsGroups }
        set { listStore.daemonSupportsGroups = newValue }
    }

    var hasMoreConversations: Bool {
        get { listStore.hasMoreConversations }
        set { listStore.hasMoreConversations = newValue }
    }

    var isLoadingMoreConversations: Bool {
        get { listStore.isLoadingMoreConversations }
        set { listStore.isLoadingMoreConversations = newValue }
    }

    var serverOffset: Int {
        get { listStore.serverOffset }
        set { listStore.serverOffset = newValue }
    }

    var restoreRecentConversations: Bool {
        selectionStore.restoreRecentConversations
    }

    var activeConversationId: UUID? {
        selectionStore.activeConversationId
    }

    var draftViewModel: ChatViewModel? {
        get { selectionStore.draftViewModel }
        set { selectionStore.draftViewModel = newValue }
    }

    /// The draft's pre-assigned local UUID, available whenever a draft VM exists.
    /// Callers use this to install selections like `.appEditing(_, draftLocalId)`
    /// that survive the draft-to-committed promotion.
    var draftLocalId: UUID? {
        selectionStore.draftLocalId
    }

    var pendingAnchorMessageId: UUID? {
        get { selectionStore.pendingAnchorMessageId }
        set { selectionStore.pendingAnchorMessageId = newValue }
    }

    var highlightedMessageId: UUID? {
        get { selectionStore.highlightedMessageId }
        set { selectionStore.highlightedMessageId = newValue }
    }

    // MARK: - Forwarded Computed Properties

    var sortedGroups: [ConversationGroup] { listStore.sortedGroups }

    var groupedConversations: [(group: ConversationGroup?, conversations: [ConversationModel])] {
        listStore.groupedConversations
    }

    var sidebarGroupEntries: [SidebarGroupEntry] { listStore.sidebarGroupEntries }

    var systemSidebarGroupEntries: [SidebarGroupEntry] { listStore.systemSidebarGroupEntries }

    var customSidebarGroupEntries: [SidebarGroupEntry] { listStore.customSidebarGroupEntries }

    var customGroupsEnabled: Bool {
        get { listStore.customGroupsEnabled }
        set { listStore.customGroupsEnabled = newValue }
    }

    var visibleConversations: [ConversationModel] { listStore.visibleConversations }

    var unseenVisibleConversationCount: Int { listStore.unseenVisibleConversationCount }

    var archivedConversations: [ConversationModel] { listStore.archivedConversations }

    var activeConversation: ConversationModel? { selectionStore.activeConversation }

    var activeViewModel: ChatViewModel? { selectionStore.activeViewModel }

    // MARK: - Init

    init(
        connectionManager: GatewayConnectionManager,
        eventStreamClient: EventStreamClient,
        conversationClient: ConversationClientProtocol = ConversationClient(),
        conversationForkClient: any ConversationForkClientProtocol = ConversationForkClient(),
        conversationDetailClient: any ConversationDetailClientProtocol = ConversationDetailClient(),
        conversationInferenceProfileClient: any ConversationInferenceProfileClientProtocol = ConversationInferenceProfileClient(),
        conversationAnalysisClient: ConversationAnalysisClientProtocol = ConversationAnalysisClient(),
        acpSessionStore: ACPSessionStore? = nil,
        isFirstLaunch: Bool = false,
        preChatContext: PreChatOnboardingContext? = nil
    ) {
        Self.migrateStorageKeysIfNeeded()
        self.connectionManager = connectionManager
        self.eventStreamClient = eventStreamClient
        self.conversationClient = conversationClient
        self.conversationForkClient = conversationForkClient
        self.conversationDetailClient = conversationDetailClient
        self.conversationInferenceProfileClient = conversationInferenceProfileClient
        self.conversationAnalysisClient = conversationAnalysisClient
        self.acpSessionStore = acpSessionStore
        self.conversationRestorer = ConversationRestorer(connectionManager: connectionManager, eventStreamClient: eventStreamClient)
        self.selectionStore = ConversationSelectionStore(listStore: listStore)

        // Set pre-chat context before enterDraftMode() so the first draft VM
        // picks it up when it checks preChatContext.
        self.preChatContext = preChatContext

        // On first launch (post-onboarding), skip conversation restoration — there are
        // no meaningful prior conversations. Allow activeConversationId writes immediately so
        // the wake-up conversation's UUID is persisted.
        selectionStore.isRestoringConversations = !isFirstLaunch

        wireStoreCallbacks()

        activityStore.onBusyToIdle = { [weak self] conversationId in
            self?.drainPendingNotificationCatchUp(for: conversationId)
        }
        activityStore.onAssistantActivityChange = { [weak self] conversationId, previousSnapshot, currentSnapshot in
            self?.handleAssistantMessageArrival(conversationId: conversationId, previousSnapshot: previousSnapshot, currentSnapshot: currentSnapshot)
        }

        enterDraftMode()
        conversationRestorer.delegate = self
        conversationRestorer.startObserving(skipInitialFetch: isFirstLaunch)
        if listStore.groups.isEmpty {
            listStore.groups = [.pinned, .scheduled, .background, .all]
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            for await message in self.eventStreamClient.subscribe() {
                switch message {
                case .conversationIdResolved(let localId, let serverId):
                    self.resolveConversationId(from: localId, to: serverId)
                case .conversationInferenceProfileUpdated(let message):
                    self.applyConversationInferenceProfileUpdate(
                        serverConversationId: message.conversationId,
                        profile: message.profile
                    )
                case .acpSessionSpawned, .acpSessionUpdate, .acpSessionCompleted, .acpSessionError:
                    self.acpSessionStore?.handle(message)
                default:
                    break
                }
            }
        }
    }

    /// One-time migration: rename legacy "thread" @AppStorage keys to "conversation" keys.
    static func migrateStorageKeysIfNeeded() {
        let defaults = UserDefaults.standard
        if let value = defaults.object(forKey: "restoreRecentThreads"), defaults.object(forKey: "restoreRecentConversations") == nil {
            defaults.set(value, forKey: "restoreRecentConversations")
            defaults.removeObject(forKey: "restoreRecentThreads")
        }
        if let value = defaults.string(forKey: "lastActiveThreadId"), defaults.string(forKey: "lastActiveConversationId") == nil {
            defaults.set(value, forKey: "lastActiveConversationId")
            defaults.removeObject(forKey: "lastActiveThreadId")
        }
    }

    // MARK: - Store Callback Wiring

    private func wireStoreCallbacks() {
        // Selection store → conversation restorer: load history on activation
        selectionStore.onActiveConversationChanged = { [weak self] conversationId in
            self?.conversationRestorer.loadHistoryIfNeeded(conversationId: conversationId)
        }

        // Selection store → activity store: observe active VM message count
        selectionStore.onActiveViewModelChanged = { [weak self] messageManager in
            self?.activityStore.observeActiveViewModel(messageManager)
        }

        // Selection store → this facade: VM factory using app-layer dependencies
        selectionStore.viewModelFactory = { [weak self] in
            self?.makeViewModel()
        }

        // Selection store → this facade: set up subscriptions on new VMs
        selectionStore.onViewModelRegistered = { [weak self] conversationId, vm in
            guard let self else { return }
            self.activityStore.observeBusyState(for: conversationId, messageManager: vm.messageManager)
            self.activityStore.observeAssistantActivity(for: conversationId, messageManager: vm.messageManager)
            self.activityStore.observeInteractionState(for: conversationId, messageManager: vm.messageManager, errorManager: vm.errorManager)
        }

        // Selection store → this facade: full cleanup on permanent VM removal
        selectionStore.onViewModelRemoved = { [weak self] conversationId in
            self?.unsubscribeAllForConversation(id: conversationId)
        }

        // Selection store → this facade: light cleanup on LRU eviction
        selectionStore.onViewModelEvicted = { [weak self] conversationId in
            self?.unsubscribeFromBusyState(for: conversationId)
        }

        // Selection store → conversation restorer: channel refresh history fetch
        selectionStore.onChannelRefreshNeeded = { [weak self] _, daemonConversationId in
            self?.conversationRestorer.requestReconnectHistory(conversationId: daemonConversationId)
        }

        // Selection store → this facade: mark active conversation seen after restoration
        selectionStore.onRestorationComplete = { [weak self] in
            self?.markActiveConversationSeenIfNeeded()
        }

        // List store → selection store: refresh cached active conversation after
        // any conversations mutation so views stay current without tracking the
        // full conversations array.
        listStore.onDerivedPropertiesRecomputed = { [weak self] in
            self?.selectionStore.refreshActiveConversation()
        }

        // List store → selection store: schedule eviction after appending conversations
        listStore.onConversationsAppended = { [weak self] in
            self?.selectionStore.scheduleEvictionIfNeeded()
        }

        // List store → activity store: check if conversation has live activity snapshot
        listStore.hasAssistantActivitySnapshot = { [weak self] conversationId in
            self?.activityStore.latestAssistantActivitySnapshots[conversationId] != nil
        }
    }

    // MARK: - ConversationRestorerDelegate

    func chatViewModel(for conversationId: UUID) -> ChatViewModel? {
        selectionStore.chatViewModel(for: conversationId)
    }

    func existingChatViewModel(for conversationId: UUID) -> ChatViewModel? {
        selectionStore.existingChatViewModel(for: conversationId)
    }

    func existingChatViewModel(forConversationId conversationId: String) -> ChatViewModel? {
        selectionStore.existingChatViewModel(forConversationId: conversationId)
    }

    func setChatViewModel(_ vm: ChatViewModel, for conversationId: UUID) {
        selectionStore.setChatViewModel(vm, for: conversationId)
    }

    func removeChatViewModel(for conversationId: UUID) {
        selectionStore.removeChatViewModel(for: conversationId)
    }

    func activateConversation(_ id: UUID) {
        let previousActiveId = selectionStore.activeConversationId

        // Channel conversations: invalidate cache before activation so
        // loadHistoryIfNeeded fetches fresh data from the daemon.
        if let conversation = listStore.conversations.first(where: { $0.id == id }),
           conversation.isChannelConversation,
           let vm = selectionStore.chatViewModels[id] {
            vm.isChannelConversation = true
            if vm.isHistoryLoaded {
                vm.prepareForChannelRefresh()
            }
        }

        selectionStore.performActivation(for: id)

        // Emit explicit seen signal for user-initiated conversation activation.
        // Skip during conversation restoration to avoid false "seen" signals on bootstrap.
        if !selectionStore.isRestoringConversations, id != previousActiveId {
            listStore.markConversationSeen(conversationId: id)
        }
    }

    func isConversationArchived(_ conversationId: String) -> Bool {
        listStore.isConversationArchived(conversationId)
    }

    func appendConversations(from response: ConversationListResponseMessage) {
        listStore.appendConversations(from: response)
    }

    func mergeAssistantAttention(from item: ConversationListResponseItem, intoConversationAt index: Int) {
        listStore.mergeAssistantAttention(from: item, intoConversationAt: index)
    }

    func restoreLastActiveConversation() {
        selectionStore.restoreLastActiveConversation()
    }

    // MARK: - VM Factory

    func makeViewModel() -> ChatViewModel {
        let viewModel = ChatViewModel(connectionManager: connectionManager, eventStreamClient: eventStreamClient)
        viewModel.shouldAcceptConfirmation = { [weak self, weak viewModel] in
            guard let self, let viewModel else { return false }
            return self.isLatestToolUseRecipient(viewModel)
        }
        viewModel.shouldCreateInlineErrorMessage = { error in
            !error.isCreditsExhausted && !error.isProviderNotConfigured && !error.isManagedKeyInvalid
        }
        viewModel.onManagedKeyInvalid = { [weak self] in
            guard let self else { return }
            Task { @MainActor in
                await self.reprovisionManagedKey()
            }
        }
        viewModel.onInlineConfirmationResponse = { [weak self] requestId, decision in
            self?.onInlineConfirmationResponse?(requestId, decision)
        }
        viewModel.onWatchStarted = { [weak self] msg, client in
            guard let self else { return }
            let session = WatchSession(
                watchId: msg.watchId,
                conversationId: msg.conversationId,
                durationSeconds: Int(msg.durationSeconds),
                intervalSeconds: Int(msg.intervalSeconds)
            )
            self.ambientAgent?.activeWatchSession = session
            session.start(connectionManager: client)
        }
        viewModel.onWatchCompleteRequest = { [weak self] _ in
            self?.ambientAgent?.activeWatchSession?.stop()
            self?.ambientAgent?.activeWatchSession = nil
        }
        viewModel.onStopWatch = { [weak self] in
            self?.ambientAgent?.activeWatchSession?.stop()
            self?.ambientAgent?.activeWatchSession = nil
        }
        viewModel.onConversationCreated = { [weak self, weak viewModel] conversationId in
            guard let self, let viewModel else { return }
            self.backfillConversationId(conversationId, for: viewModel)
        }
        viewModel.onVoiceResponseComplete = { responseText in
            guard !NSApp.isActive else { return }
            let content = UNMutableNotificationContent()
            content.title = "Response Ready"
            content.body = String(responseText.prefix(200))
            content.sound = .default
            content.categoryIdentifier = "VOICE_RESPONSE_COMPLETE"

            let request = UNNotificationRequest(
                identifier: "voice-response-\(UUID().uuidString)",
                content: content,
                trigger: nil
            )
            UNUserNotificationCenter.current().add(request) { error in
                if let error {
                    log.error("Failed to post voice response notification: \(error.localizedDescription)")
                }
            }
        }
        viewModel.onUserMessageSent = { [weak self, weak viewModel] in
            guard let self, let viewModel else { return }
            if let localId = self.selectionStore.chatViewModels.first(where: { $0.value === viewModel })?.key {
                self.listStore.updateLastInteracted(conversationId: localId)
            }
        }
        viewModel.onFork = { [weak self] in
            Task { @MainActor [weak self] in
                await self?.forkActiveConversation()
            }
        }
        viewModel.onReconnectHistoryNeeded = { [weak self] conversationId in
            guard let self else { return }
            self.conversationRestorer.requestReconnectHistory(conversationId: conversationId)
        }
        return viewModel
    }

    // MARK: - Conversation CRUD

    func createConversation() {
        if selectionStore.draftViewModel != nil, selectionStore.activeConversationId == nil {
            return
        }
        if let activeId = selectionStore.activeConversationId,
           let vm = selectionStore.chatViewModels[activeId],
           vm.messages.isEmpty {
            let activeConversation = listStore.conversations.first(where: { $0.id == activeId })
            if activeConversation?.conversationId == nil {
                return
            }
        }
        enterDraftMode()
    }

    @discardableResult
    func openConversation(
        message: String? = nil,
        forceNew: Bool = false,
        autoSend: Bool = true,
        configure: ((ChatViewModel) -> Void)? = nil
    ) -> ChatViewModel? {
        if forceNew || activeViewModel == nil {
            if forceNew {
                enterDraftMode()
            } else {
                createConversation()
            }
        }
        guard let viewModel = activeViewModel else { return nil }
        configure?(viewModel)
        if let message {
            viewModel.inputText = message
            if autoSend {
                viewModel.sendMessage()
            }
        }
        return viewModel
    }

    func ensureActiveConversation(preferredConversationId: String? = nil) {
        guard activeViewModel == nil else { return }
        if let conversationId = preferredConversationId,
           let match = listStore.conversations.first(where: { $0.conversationId == conversationId && !$0.isArchived }) {
            selectConversation(id: match.id)
        } else if let first = listStore.visibleConversations.first {
            selectConversation(id: first.id)
        } else {
            createConversation()
        }
    }

    @discardableResult
    func prepareActiveConversationForVoiceMode(timeoutSeconds: TimeInterval = 3.0) async -> ChatViewModel? {
        if activeViewModel == nil {
            enterDraftMode()
        }
        guard let viewModel = activeViewModel else { return nil }

        if selectionStore.activeConversationId == nil,
           selectionStore.draftViewModel === viewModel {
            promoteDraft(fromUserSend: false)
        }

        if viewModel.conversationId != nil {
            return viewModel
        }

        viewModel.createConversationIfNeeded()

        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if viewModel.conversationId != nil {
                return viewModel
            }
            if !viewModel.isBootstrapping {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        return viewModel.conversationId == nil ? nil : viewModel
    }

    func enterDraftMode() {
        if let draftVM = selectionStore.draftViewModel, draftVM.messages.isEmpty, selectionStore.activeConversationId == nil {
            return
        }
        let viewModel = makeViewModel()
        viewModel.isHistoryLoaded = true
        // Forward pending pre-chat onboarding context to the draft VM so
        // the first message POST includes it. Consume from the manager so
        // only the first draft conversation gets the context.
        if let context = preChatContext {
            viewModel.pendingOnboardingContext = context
            preChatContext = nil
        }
        viewModel.onUserMessageSent = { [weak self] in
            self?.promoteDraft(fromUserSend: true)
        }
        selectionStore.draftViewModel = viewModel
        // Pre-generate the local UUID so overlay selections like
        // `.appEditing(_, draftLocalId)` are valid during draft mode and stay
        // valid across promotion (promoteDraft reuses this id).
        selectionStore.draftLocalId = UUID()
        selectionStore.performDeactivation()
        activityStore.observeActiveViewModel(viewModel.messageManager)
        log.info("Entered draft mode")
    }

    private func promoteDraft(fromUserSend: Bool) {
        guard let viewModel = selectionStore.draftViewModel else { return }

        // Reuse the draft's pre-assigned local UUID so any selection that
        // references it (e.g. `.appEditing(_, draftLocalId)`) stays valid
        // without an extra state transition after promotion.
        let localId = selectionStore.draftLocalId ?? UUID()
        let conversation = ConversationModel(
            id: localId,
            title: "Untitled",
            groupId: ConversationGroup.all.id,
            inferenceProfile: viewModel.pendingInferenceProfile
        )
        listStore.conversations.insert(conversation, at: 0)
        selectionStore.chatViewModels[conversation.id] = viewModel
        activityStore.observeBusyState(for: conversation.id, messageManager: viewModel.messageManager)
        activityStore.observeAssistantActivity(for: conversation.id, messageManager: viewModel.messageManager)
        activityStore.observeInteractionState(for: conversation.id, messageManager: viewModel.messageManager, errorManager: viewModel.errorManager)
        selectionStore.touchVMAccessOrder(conversation.id)
        selectionStore.scheduleEvictionIfNeeded()
        selectionStore.draftViewModel = nil
        selectionStore.draftLocalId = nil

        if fromUserSend {
            selectionStore.completedConversationCount += 1
        }

        if !fromUserSend {
            viewModel.onFirstUserMessage = { [weak self] _ in
                self?.selectionStore.completedConversationCount += 1
                if self?.listStore.pendingRenames[localId] == nil {
                    self?.listStore.updateConversationTitle(id: localId, title: "Untitled")
                }
                self?.listStore.updateLastInteracted(conversationId: localId)
            }
        }
        viewModel.onUserMessageSent = { [weak self] in
            self?.listStore.updateLastInteracted(conversationId: localId)
        }

        selectionStore.performActivation(for: conversation.id)
        listStore.updateLastInteracted(conversationId: conversation.id)
        log.info("Promoted draft to conversation \(conversation.id)")
    }

    @discardableResult
    private func createBackgroundConversation(
        conversationId: String,
        title: String,
        source: String? = nil,
        scheduleJobId: String? = nil,
        markHistoryLoaded: Bool = true,
        groupId: String? = nil
    ) -> UUID? {
        guard !listStore.conversations.contains(where: { $0.conversationId == conversationId }) else {
            return nil
        }

        var conversation = ConversationModel(title: title, conversationId: conversationId, groupId: groupId)
        if let source { conversation.source = source }
        if let scheduleJobId { conversation.scheduleJobId = scheduleJobId }
        let viewModel = makeViewModel()
        viewModel.conversationId = conversationId
        if markHistoryLoaded {
            viewModel.isHistoryLoaded = true
        }
        viewModel.startMessageLoop()

        listStore.conversations.insert(conversation, at: 0)
        selectionStore.chatViewModels[conversation.id] = viewModel
        activityStore.observeBusyState(for: conversation.id, messageManager: viewModel.messageManager)
        activityStore.observeAssistantActivity(for: conversation.id, messageManager: viewModel.messageManager)
        activityStore.observeInteractionState(for: conversation.id, messageManager: viewModel.messageManager, errorManager: viewModel.errorManager)
        selectionStore.touchVMAccessOrder(conversation.id)
        selectionStore.scheduleEvictionIfNeeded()

        return conversation.id
    }

    func createTaskRunConversation(conversationId: String, workItemId: String, title: String) {
        guard let localId = createBackgroundConversation(conversationId: conversationId, title: title, source: "task", groupId: ConversationGroup.background.id) else { return }
        log.info("Created task run conversation \(localId) for conversation \(conversationId) (work item \(workItemId))")
    }

    func createScheduleConversation(conversationId: String, scheduleJobId: String, title: String) {
        guard let localId = createBackgroundConversation(
            conversationId: conversationId,
            title: title,
            source: "schedule",
            scheduleJobId: scheduleJobId,
            groupId: ConversationGroup.scheduled.id
        ) else { return }
        log.info("Created schedule conversation \(localId) for conversation \(conversationId) (schedule \(scheduleJobId))")
    }

    func createNotificationConversation(conversationId: String, title: String, sourceEventName: String, groupId: String? = nil, source: String? = nil) {
        guard let localId = createBackgroundConversation(
            conversationId: conversationId,
            title: title,
            source: source ?? "notification",
            markHistoryLoaded: false,
            groupId: groupId ?? ConversationGroup.all.id
        ) else { return }
        log.info("Created notification conversation \(localId) for conversation \(conversationId) (source: \(sourceEventName), groupId: \(groupId ?? "nil"))")
    }

    func createHeartbeatConversation(conversationId: String, title: String) {
        guard let localId = createBackgroundConversation(
            conversationId: conversationId,
            title: title,
            source: "heartbeat",
            groupId: ConversationGroup.background.id
        ) else { return }
        log.info("Created heartbeat conversation \(localId) for conversation \(conversationId)")
    }

    // MARK: - Close / Archive / Unarchive

    func closeConversation(id: UUID) {
        guard listStore.conversations.count > 1 else { return }
        guard let index = listStore.conversations.firstIndex(where: { $0.id == id }) else { return }
        selectionStore.chatViewModels[id]?.stopGenerating()
        listStore.conversations.remove(at: index)
        selectionStore.removeChatViewModel(for: id)
        ConversationSelectionStore.clearRenderCaches()
        if selectionStore.activeConversationId == id {
            if index < listStore.conversations.count {
                selectionStore.performActivation(for: listStore.conversations[index].id)
            } else if let lastId = listStore.conversations.last?.id {
                selectionStore.performActivation(for: lastId)
            } else {
                selectionStore.performDeactivation()
            }
        }
        log.info("Closed conversation \(id)")
    }

    func archiveConversation(id: UUID) {
        guard let index = listStore.conversations.firstIndex(where: { $0.id == id }) else { return }
        let hadOrder = listStore.conversations[index].displayOrder != nil

        var conversation = listStore.conversations[index]
        conversation.displayOrder = nil
        conversation.isArchived = true
        listStore.conversations[index] = conversation

        if hadOrder {
            listStore.sendReorderConversations()
        }

        AppDelegate.shared?.threadWindowManager?.closeThread(conversationLocalId: id)
        selectionStore.pinnedViewModelIds.remove(id)

        if let conversationId = listStore.conversations[index].conversationId {
            selectionStore.chatViewModels[id]?.stopGenerating()
            listStore.markArchived(conversationId)
            selectionStore.removeChatViewModel(for: id)
            Task { await conversationClient.archiveConversation(conversationId) }
        } else if selectionStore.chatViewModels[id]?.messages.contains(where: { $0.role == .user }) != true
                    && selectionStore.chatViewModels[id]?.isBootstrapping != true {
            selectionStore.chatViewModels[id]?.stopGenerating()
            selectionStore.removeChatViewModel(for: id)
        } else {
            selectionStore.chatViewModels[id]?.cancelPendingMessage()
        }

        if listStore.visibleConversations.isEmpty {
            enterDraftMode()
        } else if selectionStore.activeConversationId == id {
            let visibleAfter = listStore.conversations[index...].dropFirst().first(where: { !$0.isArchived })
            let visibleBefore = listStore.conversations[..<index].last(where: { !$0.isArchived })
            if let next = visibleAfter ?? visibleBefore {
                selectionStore.performActivation(for: next.id)
            } else if let firstVisibleId = listStore.visibleConversations.first?.id {
                selectionStore.performActivation(for: firstVisibleId)
            }
        }

        ConversationSelectionStore.clearRenderCaches()
        log.info("Archived conversation \(id)")
    }

    func archiveAllConversations(ids: [UUID]) {
        guard !ids.isEmpty else { return }

        var needsReorder = false
        var newlyArchivedServerIds = Set<String>()
        let idsSet = Set(ids)

        var draft = listStore.conversations
        for i in draft.indices where idsSet.contains(draft[i].id) {
            if draft[i].displayOrder != nil {
                needsReorder = true
            }
            draft[i].isArchived = true
            draft[i].displayOrder = nil
            if let cid = draft[i].conversationId {
                newlyArchivedServerIds.insert(cid)
            }
        }
        listStore.conversations = draft

        if !newlyArchivedServerIds.isEmpty {
            listStore.markArchived(newlyArchivedServerIds)
            for cid in newlyArchivedServerIds {
                Task { await conversationClient.archiveConversation(cid) }
            }
        }

        for id in ids {
            guard listStore.conversations.contains(where: { $0.id == id }) else { continue }

            AppDelegate.shared?.threadWindowManager?.closeThread(conversationLocalId: id)
            selectionStore.pinnedViewModelIds.remove(id)

            if let convIndex = listStore.conversations.firstIndex(where: { $0.id == id }) {
                if listStore.conversations[convIndex].conversationId != nil {
                    selectionStore.chatViewModels[id]?.stopGenerating()
                    selectionStore.removeChatViewModel(for: id)
                } else if selectionStore.chatViewModels[id]?.messages.contains(where: { $0.role == .user }) != true
                            && selectionStore.chatViewModels[id]?.isBootstrapping != true {
                    selectionStore.chatViewModels[id]?.stopGenerating()
                    selectionStore.removeChatViewModel(for: id)
                } else {
                    selectionStore.chatViewModels[id]?.cancelPendingMessage()
                }
            }
        }

        if let activeId = selectionStore.activeConversationId, idsSet.contains(activeId) {
            if listStore.visibleConversations.isEmpty {
                enterDraftMode()
            } else if let firstVisibleId = listStore.visibleConversations.first?.id {
                selectionStore.performActivation(for: firstVisibleId)
            }
        } else if listStore.visibleConversations.isEmpty {
            enterDraftMode()
        }

        ConversationSelectionStore.clearRenderCaches()

        if needsReorder {
            listStore.sendReorderConversations()
        }

        log.info("Archived \(ids.count) conversations")
    }

    func unarchiveConversation(id: UUID) {
        guard let index = listStore.conversations.firstIndex(where: { $0.id == id }) else { return }
        listStore.conversations[index].isArchived = false
        selectionStore.getOrCreateViewModel(for: id)
        if let conversationId = listStore.conversations[index].conversationId {
            listStore.unmarkArchived(conversationId)
            Task { await conversationClient.unarchiveConversation(conversationId) }
        }
        log.info("Unarchived conversation \(id)")
    }

    // MARK: - Selection

    func selectConversation(id: UUID) {
        guard let conversation = listStore.conversations.first(where: { $0.id == id }) else { return }

        // Clear stale streaming segment data from previous conversation to prevent
        // cross-conversation cache pollution from the single-entry streaming dedup cache.
        ChatBubble.lastStreamingSegments = nil

        selectionStore.removeAbandonedEmptyConversation(switching: id)

        let previousActiveId = selectionStore.activeConversationId

        if selectionStore.chatViewModels[id] == nil {
            let viewModel = makeViewModel()
            viewModel.conversationId = conversation.conversationId
            viewModel.isChannelConversation = conversation.isChannelConversation
            selectionStore.chatViewModels[id] = viewModel
            activityStore.observeBusyState(for: id, messageManager: viewModel.messageManager)
            activityStore.observeAssistantActivity(for: id, messageManager: viewModel.messageManager)
            activityStore.observeInteractionState(for: id, messageManager: viewModel.messageManager, errorManager: viewModel.errorManager)
            selectionStore.scheduleEvictionIfNeeded()
        }

        selectionStore.touchVMAccessOrder(id)

        if conversation.isChannelConversation, let vm = selectionStore.chatViewModels[id] {
            vm.isChannelConversation = true
            if vm.isHistoryLoaded {
                vm.prepareForChannelRefresh()
            }
        }

        selectionStore.performActivation(for: id)

        if id != previousActiveId {
            listStore.markConversationSeen(conversationId: id)
        }
    }

    @discardableResult
    func selectConversationByConversationId(_ conversationId: String) -> Bool {
        guard let conversation = listStore.conversations.first(where: { $0.conversationId == conversationId }) else { return false }
        selectConversation(id: conversation.id)
        return true
    }

    @discardableResult
    func openForkParentConversation(conversationId: String, sourceMessageId: String?) async -> Bool {
        if let existingConversation = listStore.conversations.first(where: { $0.conversationId == conversationId }) {
            selectConversation(id: existingConversation.id)
            if existingConversation.isArchived {
                unarchiveConversation(id: existingConversation.id)
            }
            applyPendingAnchorMessageIfPossible(
                localConversationId: selectionStore.activeConversationId,
                daemonMessageId: sourceMessageId
            )
            return true
        }

        guard let conversation = await conversationDetailClient.fetchConversation(conversationId: conversationId) else {
            return false
        }

        if let existingConversation = listStore.conversations.first(where: { $0.conversationId == conversationId }) {
            selectConversation(id: existingConversation.id)
            if existingConversation.isArchived {
                unarchiveConversation(id: existingConversation.id)
            }
            applyPendingAnchorMessageIfPossible(
                localConversationId: selectionStore.activeConversationId,
                daemonMessageId: sourceMessageId
            )
            return true
        }

        if listStore.isConversationArchived(conversation.id) {
            listStore.unmarkArchived(conversation.id)
        }

        guard let localConversationId = upsertConversation(from: conversation, isArchived: false) else {
            return false
        }

        selectConversation(id: localConversationId)
        applyPendingAnchorMessageIfPossible(
            localConversationId: localConversationId,
            daemonMessageId: sourceMessageId
        )
        return true
    }

    func selectConversationByConversationIdAsync(_ conversationId: String) async -> Bool {
        if selectConversationByConversationId(conversationId) {
            if let match = listStore.conversations.first(where: { $0.conversationId == conversationId }), match.isArchived {
                unarchiveConversation(id: match.id)
            }
            return true
        }

        guard let conversation = await conversationDetailClient.fetchConversation(conversationId: conversationId) else {
            return false
        }

        if selectConversationByConversationId(conversationId) {
            if let match = listStore.conversations.first(where: { $0.conversationId == conversationId }), match.isArchived {
                unarchiveConversation(id: match.id)
            }
            return true
        }

        if listStore.isConversationArchived(conversation.id) {
            listStore.unmarkArchived(conversation.id)
        }

        guard let localConversationId = upsertConversation(from: conversation, isArchived: false) else {
            return false
        }

        selectConversation(id: localConversationId)
        return true
    }

    // MARK: - Fork

    func forkActiveConversation() async {
        guard let conversation = activeConversation else {
            activeViewModel?.errorText = "Send a message before forking this conversation."
            return
        }
        guard let daemonMessageId = latestPersistedTipDaemonMessageId(for: conversation.id) else {
            activeViewModel?.errorText = "Send a message before forking this conversation."
            return
        }
        await forkConversation(throughDaemonMessageId: daemonMessageId)
    }

    func forkConversation(throughDaemonMessageId daemonMessageId: String?) async {
        guard let sourceConversation = activeConversation,
              let sourceConversationId = sourceConversation.conversationId else {
            activeViewModel?.errorText = "Send a message before forking this conversation."
            return
        }
        activeViewModel?.errorText = nil
        guard let forkedConversation = await conversationForkClient.forkConversation(
            conversationId: sourceConversationId,
            throughMessageId: daemonMessageId
        ) else {
            activeViewModel?.errorText = "Failed to fork conversation."
            return
        }
        let resolvedConversation = await resolveConversationSummary(for: forkedConversation)
        guard let localConversationId = upsertConversation(from: resolvedConversation, isArchived: false) else {
            activeViewModel?.errorText = "Failed to open forked conversation."
            return
        }
        selectConversation(id: localConversationId)
    }

    private func latestPersistedTipDaemonMessageId(for conversationLocalId: UUID) -> String? {
        selectionStore.chatViewModels[conversationLocalId]?.latestPersistedTipDaemonMessageId
    }

    // MARK: - Refresh

    func refreshActiveConversation() {
        guard let conversationId = activeConversation?.conversationId else { return }
        activeViewModel?.prepareForNotificationCatchUp()
        conversationRestorer.requestReconnectHistory(conversationId: conversationId)
    }

    // MARK: - Analyze

    func analyzeActiveConversation() async {
        guard let conversation = activeConversation,
              let conversationId = conversation.conversationId else {
            activeViewModel?.errorText = "Send a message before analyzing this conversation."
            return
        }
        activeViewModel?.errorText = nil
        guard let analysisConversation = await conversationAnalysisClient.analyzeConversation(
            conversationId: conversationId
        ) else {
            activeViewModel?.errorText = "Failed to create conversation analysis."
            return
        }
        let resolved = await resolveConversationSummary(for: analysisConversation)
        guard let localId = upsertConversation(from: resolved, isArchived: false) else {
            activeViewModel?.errorText = "Failed to open analysis conversation."
            return
        }
        selectConversation(id: localId)
    }

    // MARK: - Group CRUD (Delegated)

    func createGroup(name: String) async -> ConversationGroup? {
        await listStore.createGroup(name: name)
    }

    func renameGroup(_ groupId: String, name: String) async {
        await listStore.renameGroup(groupId, name: name)
    }

    func deleteGroup(_ groupId: String) async {
        await listStore.deleteGroup(groupId)
    }

    func deleteGroupAndArchiveConversations(_ groupId: String) async {
        guard let idx = listStore.groups.firstIndex(where: { $0.id == groupId }),
              !listStore.groups[idx].isSystemGroup else { return }

        let idsToArchive = listStore.conversations
            .filter { $0.groupId == groupId }
            .map(\.id)

        var updated = listStore.conversations
        var newlyArchivedServerIds = Set<String>()
        for i in updated.indices where updated[i].groupId == groupId {
            updated[i].isArchived = true
            updated[i].displayOrder = nil
            updated[i].groupId = ConversationGroup.all.id
            if let cid = updated[i].conversationId {
                newlyArchivedServerIds.insert(cid)
            }
        }
        listStore.conversations = updated

        if !newlyArchivedServerIds.isEmpty {
            listStore.markArchived(newlyArchivedServerIds)
            for cid in newlyArchivedServerIds {
                Task { await conversationClient.archiveConversation(cid) }
            }
        }

        for id in idsToArchive {
            AppDelegate.shared?.threadWindowManager?.closeThread(conversationLocalId: id)
            selectionStore.pinnedViewModelIds.remove(id)

            if let convIndex = listStore.conversations.firstIndex(where: { $0.id == id }) {
                if listStore.conversations[convIndex].conversationId != nil {
                    selectionStore.chatViewModels[id]?.stopGenerating()
                    selectionStore.removeChatViewModel(for: id)
                } else if selectionStore.chatViewModels[id]?.messages.contains(where: { $0.role == .user }) != true
                            && selectionStore.chatViewModels[id]?.isBootstrapping != true {
                    selectionStore.chatViewModels[id]?.stopGenerating()
                    selectionStore.removeChatViewModel(for: id)
                } else {
                    selectionStore.chatViewModels[id]?.cancelPendingMessage()
                }
            }
        }

        if let activeId = selectionStore.activeConversationId, idsToArchive.contains(activeId) {
            if listStore.visibleConversations.isEmpty {
                enterDraftMode()
            } else {
                if let firstVisibleId = listStore.visibleConversations.first?.id {
                    selectionStore.performActivation(for: firstVisibleId)
                }
            }
        } else if listStore.visibleConversations.isEmpty {
            enterDraftMode()
        }

        ConversationSelectionStore.clearRenderCaches()

        listStore.groups.remove(at: idx)
        await listStore.deleteGroupOnServer(groupId)
        listStore.sendReorderConversations()
    }

    func reorderGroups(_ updates: [(groupId: String, sortPosition: Double)]) async {
        await listStore.reorderGroups(updates)
    }

    // MARK: - Delegated List Operations

    func updateConversationTitle(id: UUID, title: String) {
        listStore.updateConversationTitle(id: id, title: title)
    }

    /// Set the per-conversation inference-profile override. Pass `nil` to
    /// clear the override and fall back to the workspace `llm.activeProfile`.
    /// Returns `true` when the daemon accepted the change and the local
    /// model has been updated; `false` otherwise (in which case the local
    /// model is rolled back).
    @discardableResult
    func setConversationInferenceProfile(id localId: UUID, profile: String?) async -> Bool {
        if localId == selectionStore.draftLocalId,
           let draftViewModel = selectionStore.draftViewModel {
            draftViewModel.pendingInferenceProfile = profile
            return true
        }

        guard let index = listStore.conversations.firstIndex(where: { $0.id == localId }),
              let conversationId = listStore.conversations[index].conversationId else {
            return false
        }

        let previousProfile = listStore.conversations[index].inferenceProfile
        guard previousProfile != profile else { return true }

        listStore.updateConversationInferenceProfile(id: localId, profile: profile)
        let response = await conversationInferenceProfileClient.setConversationInferenceProfile(
            conversationId: conversationId,
            profile: profile
        )
        guard let response else {
            listStore.updateConversationInferenceProfile(id: localId, profile: previousProfile)
            return false
        }

        applyConversationInferenceProfileUpdate(
            serverConversationId: response.conversationId,
            profile: response.profile
        )
        return true
    }

    func renameConversation(id: UUID, title: String) {
        listStore.renameConversation(id: id, title: title)
    }

    func updateLastInteracted(conversationId: UUID) {
        listStore.updateLastInteracted(conversationId: conversationId)
    }

    func pinConversation(id: UUID) {
        listStore.pinConversation(id: id)
    }

    func unpinConversation(id: UUID) {
        listStore.unpinConversation(id: id)
    }

    func moveConversationToGroup(_ conversationId: UUID, groupId: String?) {
        listStore.moveConversationToGroup(conversationId, groupId: groupId)
    }

    @discardableResult
    func moveConversation(sourceId: UUID, targetId: UUID, insertAfterTarget: Bool? = nil) -> Bool {
        listStore.moveConversation(sourceId: sourceId, targetId: targetId, insertAfterTarget: insertAfterTarget)
    }

    func loadMoreConversations() {
        listStore.loadMoreConversations()
    }

    func loadAllRemainingConversations() {
        listStore.loadAllRemainingConversations()
    }

    func markConversationSeen(conversationId: UUID) {
        listStore.markConversationSeen(conversationId: conversationId)
    }

    func markConversationUnread(conversationId localId: UUID) {
        listStore.markConversationUnread(conversationId: localId)
    }

    @discardableResult
    func markAllConversationsSeen() -> [UUID] {
        listStore.markAllConversationsSeen()
    }

    @discardableResult
    func markConversationsSeen(in localIds: Set<UUID>) -> [UUID] {
        listStore.markConversationsSeen(in: localIds)
    }

    func commitPendingSeenSignals() {
        listStore.commitPendingSeenSignals()
    }

    func cancelPendingSeenSignals() {
        listStore.cancelPendingSeenSignals()
    }

    func schedulePendingSeenSignals(delay: TimeInterval = 5.0, onCommit: (() -> Void)? = nil) {
        listStore.schedulePendingSeenSignals(delay: delay, onCommit: onCommit)
    }

    func restoreUnseen(conversationIds: [UUID]) {
        listStore.restoreUnseen(conversationIds: conversationIds)
    }

    // MARK: - Delegated Selection Operations

    func pinViewModel(_ conversationLocalId: UUID) {
        selectionStore.pinViewModel(conversationLocalId)
    }

    func unpinViewModel(_ conversationLocalId: UUID) {
        selectionStore.unpinViewModel(conversationLocalId)
    }

    func viewModelForDetachedWindow(conversationLocalId: UUID) -> ChatViewModel? {
        selectionStore.viewModelForDetachedWindow(conversationLocalId: conversationLocalId)
    }

    func clearActiveSurface(conversationId: UUID) {
        selectionStore.chatViewModels[conversationId]?.activeSurfaceId = nil
    }

    func setPendingAnchorMessage(conversationId: UUID, messageId: UUID) {
        guard selectionStore.activeConversationId == conversationId else { return }
        selectionStore.pendingAnchorMessageId = messageId
        selectionStore.pendingAnchorConversationId = conversationId
    }

    // MARK: - Delegated Activity Operations

    func isConversationBusy(_ conversationId: UUID) -> Bool {
        activityStore.isConversationBusy(conversationId)
    }

    func interactionState(for conversationId: UUID) -> ConversationInteractionState {
        activityStore.interactionState(for: conversationId)
    }

    // MARK: - Cross-Cutting Query Helpers

    func conversationHasMessages(_ id: UUID) -> Bool {
        selectionStore.chatViewModels[id]?.messages.contains(where: { $0.role == .user }) ?? false
    }

    func updateConfirmationStateAcrossConversations(requestId: String, decision: String) {
        for (_, vm) in selectionStore.chatViewModels {
            vm.updateConfirmationState(requestId: requestId, decision: decision)
        }
    }

    func isLatestToolUseRecipient(_ viewModel: ChatViewModel) -> Bool {
        guard let timestamp = viewModel.lastToolUseReceivedAt else { return false }
        for other in selectionStore.chatViewModels.values where other !== viewModel {
            if let otherTimestamp = other.lastToolUseReceivedAt, otherTimestamp > timestamp {
                return false
            }
        }
        return true
    }

    func markActiveConversationSeenIfNeeded() {
        guard NSApp.isActive,
              !selectionStore.isRestoringConversations,
              let activeId = selectionStore.activeConversationId,
              let idx = listStore.conversations.firstIndex(where: { $0.id == activeId }),
              listStore.conversations[idx].hasUnseenLatestAssistantMessage else { return }
        listStore.markConversationSeen(conversationId: activeId)
    }

    // MARK: - Notification Intent

    func handleNotificationIntentForExistingConversation(daemonConversationId: String) {
        guard let idx = listStore.conversations.firstIndex(where: { $0.conversationId == daemonConversationId }) else { return }
        let localId = listStore.conversations[idx].id
        var conversation = listStore.conversations[idx]
        conversation.lastInteractedAt = Date()

        if localId != selectionStore.activeConversationId {
            if !conversation.shouldSuppressUnreadIndicator {
                conversation.hasUnseenLatestAssistantMessage = true
            }
            conversation.latestAssistantMessageAt = Date()
            listStore.pendingSeenConversationIds.removeAll { $0 == daemonConversationId }
        }
        listStore.conversations[idx] = conversation

        if let vm = selectionStore.chatViewModels[localId], !vm.isThinking, !vm.isSending {
            pendingNotificationCatchUpIds.remove(daemonConversationId)
            vm.prepareForNotificationCatchUp()
            conversationRestorer.requestReconnectHistory(conversationId: daemonConversationId)
        } else if selectionStore.chatViewModels[localId] != nil {
            pendingNotificationCatchUpIds.insert(daemonConversationId)
        }
    }

    // MARK: - Private Helpers

    private func resolveConversationSummary(for fallback: ConversationListResponseItem) async -> ConversationListResponseItem {
        guard let detail = await conversationDetailClient.fetchConversation(conversationId: fallback.id) else {
            return fallback
        }
        return detail
    }

    @discardableResult
    private func upsertConversation(from item: ConversationListResponseItem, isArchived: Bool) -> UUID? {
        if !isArchived && listStore.isConversationArchived(item.id) {
            listStore.unmarkArchived(item.id)
        }

        if let existingIdx = listStore.conversations.firstIndex(where: { $0.conversationId == item.id }) {
            let existingConversation = listStore.conversations[existingIdx]
            let updatedConversation = listStore.conversationModel(
                from: item,
                localId: existingConversation.id,
                createdAt: existingConversation.createdAt,
                isArchived: isArchived
            )
            listStore.conversations[existingIdx] = updatedConversation
            listStore.mergeAssistantAttention(from: item, intoConversationAt: existingIdx)
            if let viewModel = selectionStore.chatViewModels[existingConversation.id] {
                viewModel.conversationId = item.id
                viewModel.isChannelConversation = updatedConversation.isChannelConversation
                viewModel.ensureMessageLoopStarted()
            }
            return existingConversation.id
        }

        let conversationModel = listStore.conversationModel(from: item, isArchived: isArchived)
        let viewModel = makeViewModel()
        viewModel.conversationId = item.id
        viewModel.isChannelConversation = conversationModel.isChannelConversation
        viewModel.startMessageLoop()

        listStore.conversations.insert(conversationModel, at: 0)
        selectionStore.chatViewModels[conversationModel.id] = viewModel
        activityStore.observeBusyState(for: conversationModel.id, messageManager: viewModel.messageManager)
        activityStore.observeAssistantActivity(for: conversationModel.id, messageManager: viewModel.messageManager)
        activityStore.observeInteractionState(for: conversationModel.id, messageManager: viewModel.messageManager, errorManager: viewModel.errorManager)
        selectionStore.touchVMAccessOrder(conversationModel.id)
        selectionStore.scheduleEvictionIfNeeded()
        return conversationModel.id
    }

    private func applyPendingAnchorMessageIfPossible(localConversationId: UUID?, daemonMessageId: String?) {
        guard let localConversationId,
              let daemonMessageId,
              let messageId = UUID(uuidString: daemonMessageId) else { return }
        setPendingAnchorMessage(conversationId: localConversationId, messageId: messageId)
    }

    // MARK: - Conversation ID Resolution

    private func resolveConversationId(from syntheticId: String, to serverId: String) {
        guard let index = listStore.conversations.firstIndex(where: { $0.conversationId == syntheticId }) else {
            log.warning("resolveConversationId: no conversation found with synthetic ID \(syntheticId, privacy: .public)")
            return
        }
        listStore.conversations[index].conversationId = serverId

        if let vm = selectionStore.chatViewModels.values.first(where: { $0.conversationId == syntheticId }) {
            vm.conversationId = serverId
        }

        // Migrate keyed state from the synthetic ID to the real server ID.
        if let override = listStore.pendingAttentionOverrides.removeValue(forKey: syntheticId) {
            listStore.pendingAttentionOverrides[serverId] = override
        }
        // Preserves the original archive timestamp across the synthetic → server id swap.
        listStore.replaceArchivedKey(from: syntheticId, to: serverId)
        if let idx = listStore.pendingSeenConversationIds.firstIndex(of: syntheticId) {
            listStore.pendingSeenConversationIds[idx] = serverId
        }

        listStore.sendReorderConversations()

        let uuidKey = listStore.conversations[index].id
        if let pendingTitle = listStore.pendingRenames.removeValue(forKey: uuidKey) {
            Task { await listStore.conversationListClient.renameConversation(conversationId: serverId, name: pendingTitle) }
        }

        // Clean up the SSE remapping entry now that the VM uses the server ID.
        // This prevents stale remapping and updates host-tool-request filtering.
        eventStreamClient.cleanupAfterConversationIdResolution(localId: syntheticId, serverId: serverId)

        log.info("Resolved synthetic conversation ID \(syntheticId, privacy: .public) → \(serverId, privacy: .public)")
    }

    private func backfillConversationId(_ conversationId: String, for viewModel: ChatViewModel) {
        guard let localId = selectionStore.chatViewModels.first(where: { $0.value === viewModel })?.key else { return }
        backfillConversationId(conversationId, for: localId)
    }

    private func backfillConversationId(_ conversationId: String, for localId: UUID) {
        guard let index = listStore.conversations.firstIndex(where: { $0.id == localId }) else { return }

        // Guard against duplicate backfills (e.g. correlation ID + SSE both arrive).
        guard listStore.conversations[index].conversationId == nil || listStore.conversations[index].conversationId == conversationId else {
            return
        }

        listStore.conversations[index].conversationId = conversationId

        // Flush any rename that was queued before the conversation ID was known.
        if let pendingTitle = listStore.pendingRenames.removeValue(forKey: localId) {
            Task { await listStore.conversationListClient.renameConversation(conversationId: conversationId, name: pendingTitle) }
        }

        // Persist archive state now that we have a server ID.
        if listStore.conversations[index].isArchived {
            listStore.markArchived(conversationId)
            Task { await conversationClient.archiveConversation(conversationId) }
            // The conversation was archived while waiting for a server ID.
            // Now that backfill is complete, release the ViewModel we were
            // keeping alive solely for the correlation ID callback.
            selectionStore.chatViewModels[localId]?.stopGenerating()
            selectionStore.removeChatViewModel(for: localId)
        }

        // Re-send ordering now that this conversation has a conversation ID.
        // Any drag/pin actions performed before the daemon assigned
        // a conversation ID would have been skipped by sendReorderConversations()
        // because it filters out conversations without a conversationId.
        listStore.sendReorderConversations()

        // Trigger history load if this is the active conversation (the
        // conversationId was nil when activeConversationId was first set,
        // so loadHistoryIfNeeded would have skipped it).
        if localId == selectionStore.activeConversationId {
            conversationRestorer.loadHistoryIfNeeded(conversationId: localId)
        }
    }

    private func applyConversationInferenceProfileUpdate(serverConversationId: String, profile: String?) {
        guard let localId = listStore.conversations.first(where: { $0.conversationId == serverConversationId })?.id else {
            return
        }
        listStore.updateConversationInferenceProfile(id: localId, profile: profile)
    }

    // MARK: - Assistant Activity Handling

    private func handleAssistantMessageArrival(conversationId: UUID, previousSnapshot: ConversationActivityStore.AssistantActivitySnapshot?, currentSnapshot: ConversationActivityStore.AssistantActivitySnapshot) {
        guard !selectionStore.isRestoringConversations else { return }
        if let vm = selectionStore.chatViewModels[conversationId], vm.isLoadingHistory || !vm.isHistoryLoaded {
            return
        }
        guard let index = listStore.conversations.firstIndex(where: { $0.id == conversationId }) else { return }
        let isNewMessage = previousSnapshot?.messageId != currentSnapshot.messageId
        if isNewMessage && !listStore.conversations[index].isBackgroundConversation {
            listStore.updateLastInteracted(conversationId: conversationId)
        }
        var conversation = listStore.conversations[index]
        if conversation.latestAssistantMessageAt == nil || isNewMessage {
            conversation.latestAssistantMessageAt = Date()
        }
        var shouldEmitSeenSignal = false
        if conversationId == selectionStore.activeConversationId {
            if conversation.hasUnseenLatestAssistantMessage {
                conversation.hasUnseenLatestAssistantMessage = false
            }
            let streamingJustCompleted = previousSnapshot?.isStreaming == true && !currentSnapshot.isStreaming
            if isNewMessage || streamingJustCompleted {
                shouldEmitSeenSignal = true
            }
        } else if !conversation.hasUnseenLatestAssistantMessage && !conversation.shouldSuppressUnreadIndicator {
            conversation.hasUnseenLatestAssistantMessage = true
        }
        listStore.conversations[index] = conversation
        if shouldEmitSeenSignal, let daemonId = conversation.conversationId {
            listStore.emitConversationSeenSignal(conversationId: daemonId)
        }
    }

    // MARK: - Observation Lifecycle

    /// Remove busy-state, interaction-state, and assistant-activity observation for a conversation.
    ///
    /// Does NOT clear interaction states — the last known state is preserved so
    /// that evicted (but still visible) conversations continue showing the correct
    /// sidebar cue. Callers that permanently remove a conversation (close / archive)
    /// should use `unsubscribeAllForConversation(id:)` instead.
    private func unsubscribeFromBusyState(for conversationId: UUID) {
        activityStore.unsubscribeFromBusyState(for: conversationId)
    }

    private func unsubscribeAllForConversation(id: UUID) {
        activityStore.unsubscribeAll(for: id)
    }

    // MARK: - Notification Catch-Up

    private func drainPendingNotificationCatchUp(for conversationId: UUID) {
        guard let daemonId = listStore.conversations.first(where: { $0.id == conversationId })?.conversationId,
              pendingNotificationCatchUpIds.remove(daemonId) != nil,
              let vm = selectionStore.chatViewModels[conversationId] else { return }
        vm.prepareForNotificationCatchUp()
        conversationRestorer.requestReconnectHistory(conversationId: daemonId)
    }

    // MARK: - Managed Key Reprovisioning

    private func reprovisionManagedKey() async {
        guard let assistantId = LockfileAssistant.loadActiveAssistantId(), !assistantId.isEmpty else {
            log.warning("Cannot reprovision — no connected assistant ID")
            return
        }
        log.info("Managed API key invalid — attempting reprovision for \(assistantId, privacy: .public)")
        let credentialStorage = FileCredentialStorage()
        let bootstrapService = LocalAssistantBootstrapService(credentialStorage: credentialStorage)
        do {
            _ = try await bootstrapService.reprovision(
                runtimeAssistantId: assistantId,
                clientPlatform: "macos",
                assistantVersion: connectionManager.assistantVersion
            )
            log.info("Managed API key reprovisioned successfully")
        } catch {
            log.error("Failed to reprovision managed API key: \(error.localizedDescription)")
        }
    }
}
