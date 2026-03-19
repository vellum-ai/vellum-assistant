#if os(macOS)
import XCTest
@testable import VellumAssistantLib

final class ComposerSlashCommandPickerTests: XCTestCase {

    func testPickerCommandsMatchSharedCatalogOrder() {
        XCTAssertEqual(
            SlashCommand.all.map(\.name),
            ["commands", "models", "status", "btw", "pair"]
        )
    }

    func testDeprecatedModelCommandIsNotInPickerCommands() {
        XCTAssertFalse(SlashCommand.all.contains(where: { $0.name == "model" }))
    }

    func testBtwSelectionInsertsTrailingSpaceWithoutAutoSend() throws {
        let command = try XCTUnwrap(SlashCommand.all.first(where: { $0.name == "btw" }))
        XCTAssertEqual(command.selectedInputText, "/btw ")
        XCTAssertFalse(command.shouldAutoSendOnSelect)
    }

    func testPairSelectionAutoSendsWithoutTrailingSpace() throws {
        let command = try XCTUnwrap(SlashCommand.all.first(where: { $0.name == "pair" }))
        XCTAssertEqual(command.selectedInputText, "/pair")
        XCTAssertTrue(command.shouldAutoSendOnSelect)
    }

    func testBtwTabCompletionUsesSelectionInsertionText() throws {
        let command = try XCTUnwrap(SlashCommand.all.first(where: { $0.name == "btw" }))
        XCTAssertEqual(ComposerView.slashCommandInputTextForSelection(command), "/btw ")
    }
}
#endif
