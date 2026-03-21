import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MainWindowAvatarRoutingTests: XCTestCase {

    // MARK: - Callback Wiring Tests

    /// Constructs an IdentityPanel and verifies the onClose callback clears selection.
    func testIdentityPanelOnCloseCallback() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .panel(.intelligence)
        let connectionManager = GatewayConnectionManager()

        let panel = IdentityPanel(
            onClose: { state.selection = nil },
            connectionManager: connectionManager
        )

        panel.onClose()

        XCTAssertNil(state.selection)
        connectionManager.disconnect()
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
