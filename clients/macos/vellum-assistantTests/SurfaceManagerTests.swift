import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Behavioral tests for `SurfaceManager`'s action dispatch path.
///
/// The `persistent` flag on `UiSurfaceShowMessage` flips the action-dispatch behavior:
/// - Non-persistent (default): single-shot. The first action latches the surface and any
///   subsequent action (including implicit dismiss) is suppressed client-side.
/// - Persistent: the card stays visible and multiple distinct action IDs fire; the same
///   action ID is de-duplicated per-surface via `spentActionIdsBySurface`.
///
/// These tests exercise `handleSurfaceAction` directly through the test-only
/// `registerForTesting` hook, bypassing NSPanel creation so the suite stays hermetic.
@MainActor
final class SurfaceManagerTests: XCTestCase {

    private var surfaceManager: SurfaceManager!

    /// Captured `onAction` dispatches from `SurfaceManager`'s outbound callback.
    /// In production this is wired to `SurfaceActionClient.sendSurfaceAction`.
    private var dispatched: [(conversationId: String?, surfaceId: String, actionId: String, data: [String: Any]?)] = []

    override func setUp() {
        super.setUp()
        surfaceManager = SurfaceManager()
        dispatched = []
        surfaceManager.onAction = { [weak self] conversationId, surfaceId, actionId, data in
            self?.dispatched.append((conversationId, surfaceId, actionId, data))
        }
    }

    override func tearDown() {
        surfaceManager = nil
        dispatched = []
        super.tearDown()
    }

    // MARK: - Helpers

    private func makeCardSurface(id: String, conversationId: String? = "conv-1") -> Surface {
        let card = CardSurfaceData(
            title: "Launch Conversation",
            subtitle: nil,
            body: "Pick a topic",
            metadata: nil,
            template: nil,
            templateData: nil
        )
        let actions = [
            SurfaceActionButton(id: "btn-1", label: "Topic 1", style: .primary, data: nil, index: 0),
            SurfaceActionButton(id: "btn-2", label: "Topic 2", style: .primary, data: nil, index: 1)
        ]
        return Surface(
            id: id,
            conversationId: conversationId,
            type: .card,
            title: "Launch Conversation",
            data: .card(card),
            actions: actions
        )
    }

    // MARK: - Persistent surfaces

    func testPersistentSurface_doesNotDismissOnAction() {
        let surface = makeCardSurface(id: "surf-persistent-1")
        surfaceManager.registerForTesting(surface: surface, persistent: true)

        surfaceManager.handleSurfaceAction(
            conversationId: surface.conversationId,
            surfaceId: surface.id,
            actionId: "btn-1",
            data: nil
        )

        // Persistent card stays visible — not removed from activeSurfaces on action.
        XCTAssertNotNil(surfaceManager.activeSurfaces[surface.id],
                        "Persistent surface should remain in activeSurfaces after an action")
        // The action should have been dispatched exactly once.
        XCTAssertEqual(dispatched.count, 1)
        XCTAssertEqual(dispatched.first?.surfaceId, surface.id)
        XCTAssertEqual(dispatched.first?.actionId, "btn-1")
    }

    func testPersistentSurface_blocksSameActionTwice() {
        let surface = makeCardSurface(id: "surf-persistent-dedupe")
        surfaceManager.registerForTesting(surface: surface, persistent: true)

        surfaceManager.handleSurfaceAction(
            conversationId: surface.conversationId,
            surfaceId: surface.id,
            actionId: "btn-1",
            data: nil
        )
        surfaceManager.handleSurfaceAction(
            conversationId: surface.conversationId,
            surfaceId: surface.id,
            actionId: "btn-1",
            data: nil
        )

        // Same actionId de-duped within a persistent surface.
        XCTAssertEqual(dispatched.count, 1,
                       "Same actionId clicked twice on a persistent surface should dispatch only once")
        XCTAssertEqual(dispatched.first?.actionId, "btn-1")
    }

    func testPersistentSurface_allowsSiblingAction() {
        let surface = makeCardSurface(id: "surf-persistent-siblings")
        surfaceManager.registerForTesting(surface: surface, persistent: true)

        surfaceManager.handleSurfaceAction(
            conversationId: surface.conversationId,
            surfaceId: surface.id,
            actionId: "btn-1",
            data: nil
        )
        surfaceManager.handleSurfaceAction(
            conversationId: surface.conversationId,
            surfaceId: surface.id,
            actionId: "btn-2",
            data: nil
        )

        // Sibling actions on the same persistent surface are both dispatched.
        XCTAssertEqual(dispatched.count, 2,
                       "Distinct action IDs on a persistent surface should each fire exactly once")
        XCTAssertEqual(dispatched.map(\.actionId), ["btn-1", "btn-2"])
    }

    // MARK: - Dismiss behavior

    func testPersistentSurface_userInitiatedClose_sendsDismiss() {
        // Regression: before the fix, the onDismiss guard suppressed "dismiss" for ALL
        // persistent surfaces, leaving the daemon's pending-surface entry stale and causing
        // subsequent interactive ui_show calls to be rejected. User-initiated close without
        // any prior action must still notify the daemon so it can clean up.
        let surface = makeCardSurface(id: "surf-persistent-close")
        surfaceManager.registerForTesting(surface: surface, persistent: true)

        surfaceManager.handleSurfaceDismiss(
            conversationId: surface.conversationId,
            surfaceId: surface.id
        )

        XCTAssertEqual(dispatched.count, 1,
                       "User-initiated close on a persistent surface with no prior action must emit dismiss")
        XCTAssertEqual(dispatched.first?.actionId, "dismiss")
        XCTAssertNil(surfaceManager.activeSurfaces[surface.id],
                     "Surface should be torn down after dismiss")
    }

    func testPersistentSurface_dismissAfterAction_suppressed() {
        // Preserves the original PR's fix: a co-fired onAction+onDismiss (e.g. cancel-style
        // buttons) must not double-emit — the synthetic "dismiss" is suppressed once any
        // action has fired for a persistent surface.
        let surface = makeCardSurface(id: "surf-persistent-race")
        surfaceManager.registerForTesting(surface: surface, persistent: true)

        surfaceManager.handleSurfaceAction(
            conversationId: surface.conversationId,
            surfaceId: surface.id,
            actionId: "btn-1",
            data: nil
        )
        surfaceManager.handleSurfaceDismiss(
            conversationId: surface.conversationId,
            surfaceId: surface.id
        )

        XCTAssertEqual(dispatched.count, 1,
                       "Dismiss must be suppressed when an action already fired this turn")
        XCTAssertEqual(dispatched.first?.actionId, "btn-1")
    }

    func testNonPersistentSurface_userInitiatedClose_sendsDismiss() {
        let surface = makeCardSurface(id: "surf-single-shot-close")
        surfaceManager.registerForTesting(surface: surface, persistent: false)

        surfaceManager.handleSurfaceDismiss(
            conversationId: surface.conversationId,
            surfaceId: surface.id
        )

        XCTAssertEqual(dispatched.count, 1)
        XCTAssertEqual(dispatched.first?.actionId, "dismiss")
    }

    func testNonPersistentSurface_dismissAfterAction_suppressed() {
        let surface = makeCardSurface(id: "surf-single-shot-race")
        surfaceManager.registerForTesting(surface: surface, persistent: false)

        surfaceManager.handleSurfaceAction(
            conversationId: surface.conversationId,
            surfaceId: surface.id,
            actionId: "btn-1",
            data: nil
        )
        surfaceManager.handleSurfaceDismiss(
            conversationId: surface.conversationId,
            surfaceId: surface.id
        )

        XCTAssertEqual(dispatched.count, 1,
                       "Non-persistent surface's post-action dismiss must be suppressed")
        XCTAssertEqual(dispatched.first?.actionId, "btn-1")
    }

    // MARK: - Escape-dismiss path

    func testDismissFloatingOnly_persistentSurface_sendsSyntheticDismiss() {
        // Regression: the global Escape handler routes through dismissFloatingOnly(), which
        // previously called dismissSurfaceById directly and skipped handleSurfaceDismiss.
        // That left the daemon with a stale pending-surface entry. Escape must now emit the
        // same synthetic "dismiss" the close-button path does.
        let surface = makeCardSurface(id: "surf-esc-persistent")
        surfaceManager.registerForTesting(surface: surface, persistent: true)

        surfaceManager.dismissFloatingOnly()

        XCTAssertEqual(dispatched.count, 1,
                       "Escape on a persistent surface with no prior action must emit dismiss")
        XCTAssertEqual(dispatched.first?.actionId, "dismiss")
        XCTAssertNil(surfaceManager.activeSurfaces[surface.id],
                     "Surface should be torn down after Escape")
    }

    func testDismissFloatingOnly_persistentSurfaceAfterAction_suppressed() {
        let surface = makeCardSurface(id: "surf-esc-persistent-race")
        surfaceManager.registerForTesting(surface: surface, persistent: true)

        surfaceManager.handleSurfaceAction(
            conversationId: surface.conversationId,
            surfaceId: surface.id,
            actionId: "btn-1",
            data: nil
        )
        surfaceManager.dismissFloatingOnly()

        XCTAssertEqual(dispatched.count, 1,
                       "Escape after an action on a persistent surface must not double-emit")
        XCTAssertEqual(dispatched.first?.actionId, "btn-1")
    }

    func testDismissFloatingOnly_nonPersistentSurface_sendsSyntheticDismiss() {
        let surface = makeCardSurface(id: "surf-esc-single-shot")
        surfaceManager.registerForTesting(surface: surface, persistent: false)

        surfaceManager.dismissFloatingOnly()

        XCTAssertEqual(dispatched.count, 1,
                       "Escape on a non-persistent surface with no prior action must emit dismiss")
        XCTAssertEqual(dispatched.first?.actionId, "dismiss")
    }

    func testDismissFloatingOnly_nonPersistentSurfaceAfterAction_suppressed() {
        let surface = makeCardSurface(id: "surf-esc-single-shot-race")
        surfaceManager.registerForTesting(surface: surface, persistent: false)

        surfaceManager.handleSurfaceAction(
            conversationId: surface.conversationId,
            surfaceId: surface.id,
            actionId: "btn-1",
            data: nil
        )
        surfaceManager.dismissFloatingOnly()

        XCTAssertEqual(dispatched.count, 1,
                       "Escape after an action on a non-persistent surface must not double-emit")
        XCTAssertEqual(dispatched.first?.actionId, "btn-1")
    }

    // MARK: - Non-persistent regression

    func testNonPersistentSurface_unchanged() {
        let surface = makeCardSurface(id: "surf-single-shot")
        surfaceManager.registerForTesting(surface: surface, persistent: false)

        // First action fires.
        surfaceManager.handleSurfaceAction(
            conversationId: surface.conversationId,
            surfaceId: surface.id,
            actionId: "btn-1",
            data: nil
        )
        // Second action (same or different id) is suppressed by the single-shot latch.
        surfaceManager.handleSurfaceAction(
            conversationId: surface.conversationId,
            surfaceId: surface.id,
            actionId: "btn-2",
            data: nil
        )

        XCTAssertEqual(dispatched.count, 1,
                       "Non-persistent surface should remain single-shot — only the first action dispatches")
        XCTAssertEqual(dispatched.first?.actionId, "btn-1")
    }
}
