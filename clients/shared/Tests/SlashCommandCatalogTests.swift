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

    func testIOSPickerOmitsPairingCommand() {
        let commands = ChatSlashCommandCatalog.commands(
            for: .ios,
            surface: .picker
        ).map(\.slashName)
        XCTAssertEqual(commands, ["/commands", "/models", "/status", "/btw"])
    }

    func testStatusDescriptionMatchesConversationCopy() {
        let status = ChatSlashCommandCatalog.commands(
            for: .macos,
            surface: .helpBubble
        ).first(where: { $0.name == "status" })
        XCTAssertEqual(status?.description, "Show conversation status and context usage")
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

    func testSendPathRecognitionRequiresSupportedForms() {
        XCTAssertTrue(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/commands",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertTrue(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/models",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertTrue(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/status",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertTrue(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/pair",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertTrue(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/btw follow up",
            platform: .macos,
            surface: .sendPath
        ))

        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/commands foo",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/models foo",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/status foo",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/pair foo",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/btw",
            platform: .macos,
            surface: .sendPath
        ))
    }

    func testSendPathRecognitionIsCaseSensitiveAndLowercaseOnly() {
        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/COMMANDS",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/MODELS",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/STATUS",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/PAIR",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/BTW follow up",
            platform: .macos,
            surface: .sendPath
        ))
    }

    func testPairIsAvailableOnIOSSendPathButHiddenFromDiscoverySurfaces() {
        XCTAssertTrue(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/pair",
            platform: .ios,
            surface: .sendPath
        ))

        XCTAssertNil(ChatSlashCommandCatalog.descriptor(
            forRawInput: "/pair",
            platform: .ios,
            surface: .picker
        ))
        XCTAssertNil(ChatSlashCommandCatalog.descriptor(
            forRawInput: "/pair",
            platform: .ios,
            surface: .helpBubble
        ))
    }

    func testModelMetadataRefreshOnlyForExactModelsCommand() {
        XCTAssertTrue(ChatSlashCommandCatalog.shouldRefreshModelMetadata(
            forRawInput: "/models",
            platform: .macos
        ))
        XCTAssertFalse(ChatSlashCommandCatalog.shouldRefreshModelMetadata(
            forRawInput: "/models foo",
            platform: .macos
        ))
        XCTAssertFalse(ChatSlashCommandCatalog.shouldRefreshModelMetadata(
            forRawInput: "/commands",
            platform: .macos
        ))
    }
}
