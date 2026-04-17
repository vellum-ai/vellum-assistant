import Foundation
import SwiftUI
import Testing
@testable import VellumAssistantLib
import VellumAssistantShared

/// Regression tests for the observation chain that drives the conversation
/// sidebar. Verifies that SwiftUI's `withObservationTracking` fires
/// `onChange` when the daemon's conversation-list response populates
/// `ConversationListStore`, including when the mutation is wrapped in the
/// animation-disabling `Transaction` used by `ConversationRestorer` on the
/// initial bulk restore path.
///
/// These tests pin the observation semantics the sidebar depends on:
///
/// - `ConversationListStore` is the `@Observable` source of truth. Reading
///   a stored property from a view body registers a keypath observation
///   on the store's registrar via the macro-generated getter. See the
///   [Observation framework](https://developer.apple.com/documentation/observation).
/// - `ConversationManager` exposes list-shaped state through computed
///   forwarders. Per [Managing model data in your app](https://developer.apple.com/documentation/swiftui/managing-model-data-in-your-app)
///   and `@Observable` macro semantics, the forwarders participate in
///   observation transparently because the generated getter on the store
///   still runs when the forwarder body evaluates.
/// - `withTransaction(.disablesAnimations)` controls how SwiftUI applies
///   the resulting view update; it does not suppress Observation
///   notifications. The restorer wraps the bulk assignment in such a
///   transaction to avoid per-row animation interpolation, so the sidebar
///   must still invalidate when the transaction commits.
///
/// If these tests regress, the sidebar will render an empty list on cold
/// launch until an unrelated mutation forces a body re-evaluation.
@Suite("ConversationListStore sidebar observation", .serialized)
@MainActor
struct ConversationListStoreObservationTests {

    private func sampleConversation(id: String = "c-1", title: String = "Sample") -> ConversationModel {
        ConversationModel(
            title: title,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            conversationId: id,
            groupId: ConversationGroup.all.id
        )
    }

    /// Direct path: a view reading `store.systemSidebarGroupEntries` should
    /// receive an observation notification when the store transitions from
    /// empty to populated. This is the contract the sidebar relies on.
    @Test
    func systemSidebarGroupEntriesFiresOnInitialPopulate() async {
        let store = ConversationListStore()
        store.groups = [.pinned, .scheduled, .background, .all]

        let fired = ObservationFlag()
        withObservationTracking {
            _ = store.systemSidebarGroupEntries
        } onChange: {
            Task { @MainActor in fired.set() }
        }

        store.conversations = [sampleConversation()]

        await Task.yield()
        await Task.yield()
        #expect(fired.value, "sidebar observation must fire when store.conversations transitions from empty to populated")
        #expect(!store.systemSidebarGroupEntries.isEmpty, "populated store must expose at least one system group entry")
    }

    /// Nested-@Observable forwarding path: a facade view reads its entries
    /// through a computed forwarder that reads the underlying store.
    /// Observation must still fire on the populate. If this test fails
    /// while the direct path passes, the forwarder is swallowing updates
    /// and views should bind to the store directly.
    @Test
    func forwardedSystemSidebarGroupEntriesFiresOnInitialPopulate() async {
        let store = ConversationListStore()
        let facade = Facade(listStore: store)
        store.groups = [.pinned, .scheduled, .background, .all]

        let fired = ObservationFlag()
        withObservationTracking {
            _ = facade.systemSidebarGroupEntries
        } onChange: {
            Task { @MainActor in fired.set() }
        }

        store.conversations = [sampleConversation()]

        await Task.yield()
        await Task.yield()
        #expect(fired.value, "facade-forwarded observation must fire on initial populate")
    }

    /// Restorer-exact path: bulk assignment wrapped in a
    /// `Transaction(.disablesAnimations)` is how
    /// `ConversationRestorer.handleConversationListResponse` commits the
    /// initial conversation list. That transaction controls animation, not
    /// observation, so the sidebar must still invalidate.
    @Test
    func systemSidebarGroupEntriesFiresInsideDisablesAnimationsTransaction() async {
        let store = ConversationListStore()
        store.groups = [.pinned, .scheduled, .background, .all]

        let fired = ObservationFlag()
        withObservationTracking {
            _ = store.systemSidebarGroupEntries
        } onChange: {
            Task { @MainActor in fired.set() }
        }

        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            store.conversations = [sampleConversation()]
        }

        await Task.yield()
        await Task.yield()
        #expect(fired.value, "Transaction(.disablesAnimations) must not suppress observation notifications")
    }

    /// `visibleConversations` is what the sidebar reads to drive the
    /// skeleton-vs-list branch. It must fire when conversations populate.
    @Test
    func visibleConversationsFiresOnInitialPopulate() async {
        let store = ConversationListStore()
        store.groups = [.pinned, .scheduled, .background, .all]

        let fired = ObservationFlag()
        withObservationTracking {
            _ = store.visibleConversations
        } onChange: {
            Task { @MainActor in fired.set() }
        }

        store.conversations = [sampleConversation()]

        await Task.yield()
        await Task.yield()
        #expect(fired.value, "visibleConversations observation must fire when store populates")
    }
}

/// Bridges a one-shot observation notification into a value the test body
/// can read after yielding. Matches the MainActor-isolated test context.
@MainActor
private final class ObservationFlag {
    private(set) var value = false
    func set() { value = true }
}

/// Minimal `@Observable` facade that exposes sidebar-shaped state via
/// computed properties that forward to an underlying `@Observable` store.
/// Reproduces the nested-forwarder pattern the sidebar depends on without
/// pulling in `ConversationManager`'s full dependency graph.
@Observable
@MainActor
private final class Facade {
    let listStore: ConversationListStore

    init(listStore: ConversationListStore) {
        self.listStore = listStore
    }

    var systemSidebarGroupEntries: [SidebarGroupEntry] {
        listStore.systemSidebarGroupEntries
    }

    var visibleConversations: [ConversationModel] {
        listStore.visibleConversations
    }

    var conversations: [ConversationModel] {
        get { listStore.conversations }
        set { listStore.conversations = newValue }
    }
}
