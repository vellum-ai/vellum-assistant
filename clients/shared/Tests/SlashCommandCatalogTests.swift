import XCTest
@testable import VellumAssistantShared

final class SlashCommandCatalogTests: XCTestCase {

    func testMacOSPickerOrderMatchesExpectedDesktopCommands() {
        let commands = ChatSlashCommandCatalog.commands(
            for: .macos,
            surface: .picker
        ).map(\.slashName)
        XCTAssertEqual(commands, ["/commands", "/models", "/status", "/btw", "/pair"])
    }

    func testMacOSHelpOrderMatchesExpectedDesktopCommands() {
        let commands = ChatSlashCommandCatalog.commands(
            for: .macos,
            surface: .helpBubble
        ).map(\.slashName)
        XCTAssertEqual(commands, ["/commands", "/models", "/status", "/btw", "/pair"])
    }

    func testIOSHelpOmitsPairingCommand() {
        let commands = ChatSlashCommandCatalog.commands(
            for: .ios,
            surface: .helpBubble
        ).map(\.slashName)
        XCTAssertEqual(commands, ["/commands", "/models", "/status", "/btw"])
    }

    func testBtwSelectionBehaviorUsesTrailingSpaceInsertion() {
        let descriptor = ChatSlashCommandCatalog.descriptor(
            forRawInput: "/btw tell me more",
            platform: .macos,
            surface: .picker
        )
        XCTAssertEqual(descriptor?.selectionBehavior, .insertTrailingSpace)
    }

    func testDeprecatedModelCommandIsNotDiscoverableInPickerOrHelp() {
        let pickerDescriptor = ChatSlashCommandCatalog.descriptor(
            forRawInput: "/model",
            platform: .macos,
            surface: .picker
        )
        XCTAssertNil(pickerDescriptor)

        let helpDescriptor = ChatSlashCommandCatalog.descriptor(
            forRawInput: "/model opus",
            platform: .ios,
            surface: .helpBubble
        )
        XCTAssertNil(helpDescriptor)
    }
}
