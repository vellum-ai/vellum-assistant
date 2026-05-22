import XCTest
@testable import VellumAssistantShared

final class SlashCommandCatalogTests: XCTestCase {

    func testMacOSPickerOrderMatchesExpectedDesktopCommands() {
        let commands = ChatSlashCommandCatalog.commands(
            for: .macos,
            surface: .picker
        ).map(\.slashName)
        XCTAssertEqual(commands, ["/commands", "/compact", "/clean", "/model", "/models", "/status", "/btw", "/fork"])
    }

    func testMacOSHelpOrderMatchesExpectedDesktopCommands() {
        let commands = ChatSlashCommandCatalog.commands(
            for: .macos,
            surface: .helpBubble
        ).map(\.slashName)
        XCTAssertEqual(commands, ["/commands", "/compact", "/clean", "/model", "/models", "/status", "/btw", "/fork"])
    }

    func testIOSHelpShowsForkAlongsideCommonCommands() {
        let commands = ChatSlashCommandCatalog.commands(
            for: .ios,
            surface: .helpBubble
        ).map(\.slashName)
        XCTAssertEqual(commands, ["/commands", "/compact", "/clean", "/model", "/models", "/status", "/btw", "/fork"])
    }

    func testIOSPickerOmitsForkCommand() {
        let commands = ChatSlashCommandCatalog.commands(
            for: .ios,
            surface: .picker
        ).map(\.slashName)
        XCTAssertEqual(commands, ["/commands", "/compact", "/clean", "/model", "/models", "/status", "/btw"])
    }

    func testCleanCommandIsDiscoverableInPickerAcrossPlatforms() {
        for platform in [ChatSlashCommandPlatform.macos, .ios] {
            let descriptor = ChatSlashCommandCatalog.descriptor(
                forRawInput: "/clean",
                platform: platform,
                surface: .picker
            )
            XCTAssertEqual(descriptor?.name, "clean")
            XCTAssertEqual(descriptor?.selectionBehavior, .autoSend)
        }
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

    func testModelCommandIsDiscoverableInPickerAndHelpBubble() {
        let pickerDescriptor = ChatSlashCommandCatalog.descriptor(
            forRawInput: "/model",
            platform: .macos,
            surface: .picker
        )
        XCTAssertEqual(pickerDescriptor?.name, "model")
        XCTAssertEqual(
            pickerDescriptor?.description,
            "List or switch inference profile"
        )
        XCTAssertEqual(pickerDescriptor?.selectionBehavior, .insertTrailingSpace)

        let helpDescriptor = ChatSlashCommandCatalog.descriptor(
            forRawInput: "/model alpha",
            platform: .ios,
            surface: .helpBubble
        )
        XCTAssertEqual(helpDescriptor?.name, "model")
    }

    func testSendPathRecognitionRequiresSupportedForms() {
        XCTAssertTrue(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/commands",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertTrue(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/model",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertTrue(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/model alpha",
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
            "/clean",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertTrue(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/fork",
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
            "/clean foo",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/fork foo",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/btw",
            platform: .macos,
            surface: .sendPath
        ))
    }

    func testModelMatchRuleDistinguishesModelAndModels() {
        // `/model` (bare) and `/model <name>` resolve to the model descriptor.
        XCTAssertEqual(
            ChatSlashCommandCatalog.descriptor(
                forRawInput: "/model",
                platform: .macos,
                surface: .sendPath
            )?.name,
            "model"
        )
        XCTAssertEqual(
            ChatSlashCommandCatalog.descriptor(
                forRawInput: "/model alpha",
                platform: .macos,
                surface: .sendPath
            )?.name,
            "model"
        )
        // `/models` must continue resolving to its own descriptor — the
        // `/model` rule prefix must not steal it.
        XCTAssertEqual(
            ChatSlashCommandCatalog.descriptor(
                forRawInput: "/models",
                platform: .macos,
                surface: .sendPath
            )?.name,
            "models"
        )
        // Empty argument after `/model ` is not a valid switch invocation,
        // but the trimmed form `/model` still matches as a bare invocation.
        XCTAssertEqual(
            ChatSlashCommandCatalog.descriptor(
                forRawInput: "/model    ",
                platform: .macos,
                surface: .sendPath
            )?.name,
            "model"
        )
    }

    func testSendPathRecognitionIsCaseSensitiveAndLowercaseOnly() {
        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/COMMANDS",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/MODEL",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/MODEL alpha",
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
            "/FORK",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/BTW follow up",
            platform: .macos,
            surface: .sendPath
        ))
    }

    func testForkUsesAutoSendBehaviorWhereDiscoverable() {
        let descriptor = ChatSlashCommandCatalog.descriptor(
            forRawInput: "/fork",
            platform: .macos,
            surface: .picker
        )
        XCTAssertEqual(descriptor?.selectionBehavior, .autoSend)
    }

    func testForkIsAvailableOnIOSSendPathAndHelpButHiddenFromPicker() {
        XCTAssertTrue(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/fork",
            platform: .ios,
            surface: .sendPath
        ))

        XCTAssertNil(ChatSlashCommandCatalog.descriptor(
            forRawInput: "/fork",
            platform: .ios,
            surface: .picker
        ))

        let helpDescriptor = ChatSlashCommandCatalog.descriptor(
            forRawInput: "/fork",
            platform: .ios,
            surface: .helpBubble
        )
        XCTAssertEqual(
            helpDescriptor?.description,
            "Fork the current conversation into a new branch"
        )
    }

    func testModelCommandBypassesWorkspaceRefinementInBothForms() {
        // `/model` is now a real catalog command; bypass should be driven by
        // catalog recognition, not the deprecated-shortcut fallback.
        XCTAssertTrue(ChatSlashCommandCatalog.shouldBypassWorkspaceRefinement(
            forRawInput: "/model",
            platform: .macos
        ))
        XCTAssertTrue(ChatSlashCommandCatalog.shouldBypassWorkspaceRefinement(
            forRawInput: "/model alpha",
            platform: .macos
        ))
        XCTAssertTrue(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/model",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertTrue(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/model alpha",
            platform: .macos,
            surface: .sendPath
        ))
    }

    func testDeprecatedProviderShortcutsStillBypassWorkspaceRefinement() {
        // `/opus`, `/sonnet`, etc. are not in the catalog — they reach the
        // daemon via the fallback bypass so it can return the deprecation
        // message instead of letting them fall through as raw text.
        XCTAssertTrue(ChatSlashCommandCatalog.shouldBypassWorkspaceRefinement(
            forRawInput: "/opus explain this",
            platform: .macos
        ))
        XCTAssertTrue(ChatSlashCommandCatalog.shouldBypassWorkspaceRefinement(
            forRawInput: "/OPUS explain this",
            platform: .macos
        ))
        XCTAssertTrue(ChatSlashCommandCatalog.shouldBypassWorkspaceRefinement(
            forRawInput: "/sonnet",
            platform: .macos
        ))

        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/opus explain this",
            platform: .macos,
            surface: .sendPath
        ))
        XCTAssertFalse(ChatSlashCommandCatalog.isRecognizedSlashCommand(
            "/OPUS explain this",
            platform: .macos,
            surface: .sendPath
        ))
    }

    func testModelMetadataRefreshOptsInForModelAndModelsCommands() {
        XCTAssertTrue(ChatSlashCommandCatalog.shouldRefreshModelMetadata(
            forRawInput: "/models",
            platform: .macos
        ))
        XCTAssertTrue(ChatSlashCommandCatalog.shouldRefreshModelMetadata(
            forRawInput: "/model",
            platform: .macos
        ))
        XCTAssertTrue(ChatSlashCommandCatalog.shouldRefreshModelMetadata(
            forRawInput: "/model alpha",
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
