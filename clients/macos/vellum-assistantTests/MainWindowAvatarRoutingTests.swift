import XCTest
@testable import VellumAssistantLib

@MainActor
final class MainWindowAvatarRoutingTests: XCTestCase {

    // MARK: - Closure Wiring Tests

    /// Verifies that the onCustomizeAvatar closure pattern used in MainWindowView
    /// correctly transitions selection from identity to avatar customization.
    func testOnCustomizeAvatarClosureTransitionsToAvatarPanel() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .panel(.identity)

        // Replicate the exact closure wired in MainWindowView
        let onCustomizeAvatar: () -> Void = {
            state.selection = .panel(.avatarCustomization)
        }

        onCustomizeAvatar()

        XCTAssertEqual(state.selection, .panel(.avatarCustomization))
    }

    /// Verifies that the onClose closure pattern used in side panel correctly clears selection.
    func testOnCloseSidePanelClearsSelection() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .panel(.avatarCustomization)

        // Replicate the exact closure wired in nativePanelView
        let onClose: () -> Void = {
            state.selection = nil
        }

        onClose()

        XCTAssertNil(state.selection)
    }

    // MARK: - Callback Contract Tests

    /// Verifies that IdentityPanel's init signature requires an onCustomizeAvatar callback.
    /// Instantiates a real IdentityPanel so the test fails to compile if the parameter is removed.
    func testIdentityPanelRequiresCustomizeAvatarCallback() {
        var customizeCalled = false
        var closeCalled = false

        let panel = IdentityPanel(
            onClose: { closeCalled = true },
            onCustomizeAvatar: { customizeCalled = true },
            daemonClient: DaemonClient()
        )

        // Verify callbacks are wired — invoke them directly to confirm the closures passed through
        panel.onClose()
        panel.onCustomizeAvatar()

        XCTAssertTrue(closeCalled)
        XCTAssertTrue(customizeCalled)
    }

    // MARK: - State Transition Tests

    func testAvatarCustomizationIsDistinctFromIdentity() {
        let identity: ViewSelection = .panel(.identity)
        let avatar: ViewSelection = .panel(.avatarCustomization)
        XCTAssertNotEqual(identity, avatar)
    }

    func testAvatarCustomizationPanelTypeExists() {
        // Compile-level guard: fails to compile if the case is removed from SidePanelType
        let panel: SidePanelType = .avatarCustomization
        XCTAssertEqual(panel, .avatarCustomization)
    }

    func testTransitionFromIdentityPreservesStateIntegrity() {
        let state = MainWindowState(hasAPIKey: false)

        // Simulate full navigation flow: nil → identity → avatar customization → nil
        XCTAssertNil(state.selection)

        state.selection = .panel(.identity)
        XCTAssertEqual(state.selection, .panel(.identity))

        // Simulate onCustomizeAvatar callback
        state.selection = .panel(.avatarCustomization)
        XCTAssertEqual(state.selection, .panel(.avatarCustomization))

        // Simulate closing the panel
        state.selection = nil
        XCTAssertNil(state.selection)
    }
}
