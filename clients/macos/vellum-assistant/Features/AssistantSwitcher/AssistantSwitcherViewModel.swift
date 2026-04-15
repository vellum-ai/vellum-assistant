import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AssistantSwitcherViewModel")

/// View model backing the menu-bar assistant switcher. Owns the list of
/// managed assistants eligible for the current environment, the currently
/// active assistant id, and the handlers used to switch / create / retire
/// entries.
///
/// Handlers are injected as closures so tests can substitute fakes without
/// constructing a real `ManagedAssistantConnectionCoordinator`, SSE stack,
/// or AuthService. In production the wiring site (AppDelegate) adapts those
/// closures onto the coordinator's `switchToManagedAssistant`, the hatch
/// path, and the vellum CLI retire path.
///
/// This type is `@MainActor` because it manipulates menu-bar UI state and
/// subscribes to `LockfileAssistant.activeAssistantDidChange` on the main
/// queue.
@MainActor
@Observable
final class AssistantSwitcherViewModel {
    /// Managed assistants present in the lockfile for the current runtime
    /// environment. Updated on init and whenever the active assistant
    /// changes.
    private(set) var assistants: [LockfileAssistant] = []

    /// Mirror of `LockfileAssistant.loadActiveAssistantId()` — the id the
    /// menu uses to render the checkmark.
    private(set) var selectedAssistantId: String?

    @ObservationIgnored private let switchHandler: @MainActor (String) async throws -> Void
    @ObservationIgnored private let createHandler: @MainActor (String) async throws -> Void
    @ObservationIgnored private let retireHandler: @MainActor (String) async throws -> Void
    @ObservationIgnored private let lockfileLoader: @MainActor () -> [LockfileAssistant]
    @ObservationIgnored private let activeIdLoader: @MainActor () -> String?
    @ObservationIgnored private let notificationCenter: NotificationCenter
    @ObservationIgnored private var activeChangeObserver: NSObjectProtocol?

    init(
        switchHandler: @escaping @MainActor (String) async throws -> Void,
        createHandler: @escaping @MainActor (String) async throws -> Void,
        retireHandler: @escaping @MainActor (String) async throws -> Void,
        lockfileLoader: @escaping @MainActor () -> [LockfileAssistant] = { LockfileAssistant.loadAll() },
        activeIdLoader: @escaping @MainActor () -> String? = { LockfileAssistant.loadActiveAssistantId() },
        notificationCenter: NotificationCenter = .default
    ) {
        self.switchHandler = switchHandler
        self.createHandler = createHandler
        self.retireHandler = retireHandler
        self.lockfileLoader = lockfileLoader
        self.activeIdLoader = activeIdLoader
        self.notificationCenter = notificationCenter

        refresh()

        activeChangeObserver = notificationCenter.addObserver(
            forName: LockfileAssistant.activeAssistantDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // `queue: .main` hops the closure onto the main queue, which
            // matches the @MainActor isolation of `refresh()`. Future
            // Swift-concurrency tightening may flag `assumeIsolated`, at
            // which point we can switch to a `Task { @MainActor in … }`.
            MainActor.assumeIsolated {
                self?.refresh()
            }
        }
    }

    deinit {
        // `NotificationCenter.removeObserver` is documented thread-safe,
        // which is what lets us call it from the non-isolated `deinit`
        // with the captured `notificationCenter` reference.
        if let activeChangeObserver {
            notificationCenter.removeObserver(activeChangeObserver)
        }
    }

    /// Re-read the lockfile. Exposed so the menu can force a refresh right
    /// before it is rebuilt (the `activeAssistantDidChange` notification is
    /// async, so a synchronous rebuild after a `select` would otherwise race
    /// the notification delivery).
    func refresh() {
        assistants = lockfileLoader().filter { $0.isManaged && $0.isCurrentEnvironment }
        selectedAssistantId = activeIdLoader()
    }

    /// Switch the active assistant. Calls the injected handler (which in
    /// production wraps `ManagedAssistantConnectionCoordinator.switchToManagedAssistant`)
    /// then refreshes local state synchronously so the UI updates within one
    /// event loop tick rather than waiting for `activeAssistantDidChange`.
    func select(assistantId: String) async throws {
        // No-op when the target is already the active assistant. Without
        // this guard, clicking the already-checked row would drive the
        // coordinator's teardown/bring-up path and disconnect SSE for no
        // reason, interrupting any in-flight work.
        if assistantId == selectedAssistantId {
            return
        }
        try await switchHandler(assistantId)
        // Refresh synchronously so the UI updates within this event loop
        // tick. `activeAssistantDidChange` will fire from
        // `setActiveAssistantId` and trigger a second refresh — redundant
        // but harmless, since `refresh()` is idempotent.
        refresh()
    }

    /// Hatch a new managed assistant and persist it to the lockfile. The
    /// caller is responsible for presenting the name prompt UI before
    /// invoking this method.
    func createNewAssistant(name: String) async throws {
        try await createHandler(name)
        refresh()
    }

    /// Retire an assistant via the injected handler. When the retired
    /// assistant is the active one the handler is responsible for falling
    /// back to another assistant (or the no-assistant state) — the view
    /// model only refreshes its local view of the lockfile afterwards.
    func retire(assistantId: String) async throws {
        try await retireHandler(assistantId)
        refresh()
    }
}
