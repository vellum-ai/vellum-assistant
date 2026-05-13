#if os(macOS)
import XCTest
@testable import VellumAssistantLib

final class ComposerSlashCommandPickerTests: XCTestCase {

    func testPickerCommandsMatchSharedCatalogOrder() {
        XCTAssertEqual(
            SlashCommand.all.map(\.name),
            ["commands", "compact", "model", "models", "status", "btw", "fork"]
        )
    }

    func testModelCommandIsInPickerWithTrailingSpaceBehavior() throws {
        let command = try XCTUnwrap(SlashCommand.all.first(where: { $0.name == "model" }))
        XCTAssertEqual(command.selectedInputText, "/model ")
        XCTAssertFalse(command.shouldAutoSendOnSelect)
    }

    func testBtwSelectionInsertsTrailingSpaceWithoutAutoSend() throws {
        let command = try XCTUnwrap(SlashCommand.all.first(where: { $0.name == "btw" }))
        XCTAssertEqual(command.selectedInputText, "/btw ")
        XCTAssertFalse(command.shouldAutoSendOnSelect)
    }

    func testBtwTabCompletionUsesSelectionInsertionText() throws {
        let command = try XCTUnwrap(SlashCommand.all.first(where: { $0.name == "btw" }))
        XCTAssertEqual(command.selectedInputText, "/btw ")
    }
}
#endif
