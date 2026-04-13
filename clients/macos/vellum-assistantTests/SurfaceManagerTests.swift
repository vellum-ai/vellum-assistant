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
