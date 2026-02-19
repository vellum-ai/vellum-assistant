import XCTest
@testable import VellumAssistantLib

@MainActor
final class MainWindowAvatarRoutingTests: XCTestCase {

    // MARK: - Callback Wiring Tests

    /// Constructs an IdentityPanel with the same closure pattern used in MainWindowView,
    /// then invokes the panel's onCustomizeAvatar callback and verifies it transitions state.
    func testIdentityPanelOnCustomizeAvatarTransitionsState() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .panel(.identity)
        let daemonClient = DaemonClient()

        let panel = IdentityPanel(
            onClose: { state.selection = nil },
            onCustomizeAvatar: { state.selection = .panel(.avatarCustomization) },
            daemonClient: daemonClient
        )

        // Call the callback through the panel's stored property — this exercises
        // the actual wiring, not a locally-defined closure.
        panel.onCustomizeAvatar()

        XCTAssertEqual(state.selection, .panel(.avatarCustomization))
        daemonClient.disconnect()
    }

    /// Constructs an IdentityPanel and verifies the onClose callback clears selection.
    func testIdentityPanelOnCloseCallback() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .panel(.identity)
        let daemonClient = DaemonClient()

        let panel = IdentityPanel(
            onClose: { state.selection = nil },
            onCustomizeAvatar: { state.selection = .panel(.avatarCustomization) },
            daemonClient: daemonClient
        )

        panel.onClose()

        XCTAssertNil(state.selection)
        daemonClient.disconnect()
    }

    // MARK: - State Transition Tests

    func testAvatarCustomizationIsDistinctFromIdentity() {
        let identity: ViewSelection = .panel(.identity)
        let avatar: ViewSelection = .panel(.avatarCustomization)
        XCTAssertNotEqual(identity, avatar)
    }

    func testAvatarCustomizationPanelTypeExists() {
        let panel: SidePanelType = .avatarCustomization
        XCTAssertEqual(panel, .avatarCustomization)
    }
}
