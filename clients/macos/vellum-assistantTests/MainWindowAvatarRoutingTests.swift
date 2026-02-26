import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MainWindowAvatarRoutingTests: XCTestCase {

    // MARK: - Callback Wiring Tests

    /// Constructs an IdentityPanel with the same closure pattern used in IntelligencePanel,
    /// then invokes the panel's onEditAvatar callback and verifies it clears selection
    /// (navigating back to chat).
    func testIdentityPanelOnEditAvatarClearsSelection() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .panel(.intelligence)
        let daemonClient = DaemonClient()

        let panel = IdentityPanel(
            onClose: { state.selection = nil },
            onEditAvatar: { state.selection = nil },
            daemonClient: daemonClient
        )

        panel.onEditAvatar()

        XCTAssertNil(state.selection)
        daemonClient.disconnect()
    }

    /// Constructs an IdentityPanel and verifies the onClose callback clears selection.
    func testIdentityPanelOnCloseCallback() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .panel(.intelligence)
        let daemonClient = DaemonClient()

        let panel = IdentityPanel(
            onClose: { state.selection = nil },
            onEditAvatar: { state.selection = nil },
            daemonClient: daemonClient
        )

        panel.onClose()

        XCTAssertNil(state.selection)
        daemonClient.disconnect()
    }

    // MARK: - Callback Contract Tests

    /// Verifies that IdentityPanel's init signature requires an onEditAvatar callback.
    /// Instantiates a real IdentityPanel so the test fails to compile if the parameter is removed.
    func testIdentityPanelRequiresEditAvatarCallback() {
        var editCalled = false
        var closeCalled = false
        let daemonClient = DaemonClient()

        let panel = IdentityPanel(
            onClose: { closeCalled = true },
            onEditAvatar: { editCalled = true },
            daemonClient: daemonClient
        )

        // Verify callbacks are wired — invoke them directly to confirm the closures passed through
        panel.onClose()
        panel.onEditAvatar()

        XCTAssertTrue(closeCalled)
        XCTAssertTrue(editCalled)
        daemonClient.disconnect()
    }

    // MARK: - State Transition Tests

    func testAvatarCustomizationIsDistinctFromIntelligence() {
        let intelligence: ViewSelection = .panel(.intelligence)
        let avatar: ViewSelection = .panel(.avatarCustomization)
        XCTAssertNotEqual(intelligence, avatar)
    }

    func testAvatarCustomizationPanelTypeExists() {
        let panel: SidePanelType = .avatarCustomization
        XCTAssertEqual(panel, .avatarCustomization)
    }
}
