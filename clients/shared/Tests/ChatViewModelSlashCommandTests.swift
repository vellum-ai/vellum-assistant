import XCTest
@testable import VellumAssistantShared

@MainActor
final class ChatViewModelSlashCommandTests: XCTestCase {

    private final class StubSettingsClient: SettingsClientProtocol {
        var fetchModelInfoCallCount = 0
        var modelInfoResponse: ModelInfoMessage?

        func fetchVercelConfig() async -> VercelApiConfigResponseMessage? { nil }
        func saveVercelConfig(apiToken: String) async -> VercelApiConfigResponseMessage? { nil }
        func deleteVercelConfig() async -> VercelApiConfigResponseMessage? { nil }

        func fetchModelInfo() async -> ModelInfoMessage? {
            fetchModelInfoCallCount += 1
            return modelInfoResponse
        }

        func setModel(model: String, provider: String?) async -> ModelInfoMessage? { nil }

        func setImageGenModel(modelId: String) async -> ModelInfoMessage? { nil }

        func fetchEmbeddingConfig() async -> EmbeddingConfigMessage? { nil }

        func setEmbeddingConfig(provider: String, model: String?) async -> EmbeddingConfigMessage? { nil }

        func fetchTelegramConfig() async -> TelegramConfigResponseMessage? { nil }

        func setTelegramConfig(
            action: String,
            botToken: String?,
            commands: [TelegramConfigRequestCommand]?
        ) async -> TelegramConfigResponseMessage? { nil }

        func fetchDangerouslySkipPermissions() async -> Bool? { nil }

        func setDangerouslySkipPermissions(_ enabled: Bool) async -> Bool { false }

        func setSlackWebhookConfig(action: String, webhookUrl: String?) async -> Bool { false }

        func fetchChannelVerificationStatus(channel: String) async -> ChannelVerificationSessionResponseMessage? { nil }

        func sendChannelVerificationSession(
            action: String,
            channel: String?,
            conversationId: String?,
            rebind: Bool?,
            destination: String?,
            originConversationId: String?,
            purpose: String?,
            contactChannelId: String?
        ) async -> ChannelVerificationSessionResponseMessage? { nil }

        func updateVoiceConfig(_ config: VoiceConfigUpdateRequest) async -> Bool { false }
        func startOAuthConnect(_ request: OAuthConnectStartRequest) async -> Bool { false }
        func registerDeviceToken(token: String, platform: String) async -> Bool { false }
        func fetchIngressConfig() async -> IngressConfigResponseMessage? { nil }
        func updateIngressConfig(publicBaseUrl: String?, enabled: Bool?) async -> IngressConfigResponseMessage? { nil }
        func fetchSuggestion(conversationId: String, requestId: String) async -> SuggestionResponseMessage? { nil }
        func fetchPlatformConfig() async -> PlatformConfigResponseMessage? { nil }
        func setPlatformConfig(baseUrl: String) async -> PlatformConfigResponseMessage? { nil }
        func patchConfig(_ partial: [String: Any]) async -> Bool { false }
        func fetchConfig() async -> [String: Any]? { nil }
    }

    private var connectionManager: GatewayConnectionManager!
    private var settingsClient: StubSettingsClient!
    private var viewModel: ChatViewModel!

    override func setUp() {
        super.setUp()
        connectionManager = GatewayConnectionManager()
        connectionManager.isConnected = true
        settingsClient = StubSettingsClient()
        viewModel = ChatViewModel(
            connectionManager: connectionManager,
            eventStreamClient: connectionManager.eventStreamClient,
            settingsClient: settingsClient
        )
        viewModel.conversationId = "sess-1"
    }

    override func tearDown() {
        viewModel = nil
        settingsClient = nil
        connectionManager = nil
        super.tearDown()
    }

    func testCommandsAndStatusBypassWorkspaceRefinementWhenSurfaceIsActive() {
        viewModel.activeSurfaceId = "surface-1"
        viewModel.isChatDockedToSide = false

        viewModel.inputText = "/commands"
        viewModel.sendMessage()

        XCTAssertFalse(viewModel.isWorkspaceRefinementInFlight)
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].text, "/commands")

        viewModel.inputText = "/status"
        viewModel.sendMessage()

        XCTAssertFalse(viewModel.isWorkspaceRefinementInFlight)
        XCTAssertEqual(viewModel.messages.count, 2)
        XCTAssertEqual(viewModel.messages[1].text, "/status")
    }

    func testModelsRefreshesMetadataButUnsupportedFormsDoNot() async {
        settingsClient.modelInfoResponse = ModelInfoMessage(
            type: "model_info",
            model: "test-model",
            provider: "test-provider",
            configuredProviders: ["test-provider"]
        )

        viewModel.inputText = "/models"
        viewModel.sendMessage()

        await Task.yield()
        await Task.yield()
        XCTAssertEqual(settingsClient.fetchModelInfoCallCount, 1)

        viewModel.inputText = "/models foo"
        viewModel.sendMessage()

        await Task.yield()
        await Task.yield()
        XCTAssertEqual(settingsClient.fetchModelInfoCallCount, 1)

        viewModel.inputText = "/model"
        viewModel.sendMessage()

        await Task.yield()
        await Task.yield()
        XCTAssertEqual(settingsClient.fetchModelInfoCallCount, 1)
    }

    func testUnsupportedSlashFormsUseWorkspaceRefinementWhenSurfaceIsActive() {
        viewModel.activeSurfaceId = "surface-1"
        viewModel.isChatDockedToSide = false

        let unsupportedForms = [
            "/commands foo",
            "/models foo",
            "/status foo",
            "/pair foo",
            "/btw",
        ]

        for command in unsupportedForms {
            viewModel.isWorkspaceRefinementInFlight = false
            viewModel.inputText = command
            viewModel.sendMessage()

            XCTAssertTrue(viewModel.isWorkspaceRefinementInFlight)
            XCTAssertEqual(viewModel.messages.count, 0)
        }
    }

    func testSendPathMatchingRequiresExactLowercaseCommands() {
        viewModel.activeSurfaceId = "surface-1"
        viewModel.isChatDockedToSide = false

        let mixedCaseForms = [
            "/COMMANDS",
            "/MODELS",
            "/STATUS",
            "/PAIR",
            "/BTW follow up",
        ]

        for command in mixedCaseForms {
            viewModel.isWorkspaceRefinementInFlight = false
            viewModel.inputText = command
            viewModel.sendMessage()

            XCTAssertTrue(viewModel.isWorkspaceRefinementInFlight)
            XCTAssertEqual(viewModel.messages.count, 0)
        }
    }

    func testUnknownSlashCommandsUseWorkspaceRefinementWhenSurfaceIsActive() {
        viewModel.activeSurfaceId = "surface-1"
        viewModel.isChatDockedToSide = false

        viewModel.inputText = "/foo"
        viewModel.sendMessage()

        XCTAssertTrue(viewModel.isWorkspaceRefinementInFlight)
        XCTAssertEqual(viewModel.messages.count, 0)
    }

    func testDeprecatedDaemonManagedSlashCommandsBypassWorkspaceRefinement() {
        viewModel.activeSurfaceId = "surface-1"
        viewModel.isChatDockedToSide = false

        let deprecatedCommands = [
            "/model",
            "/opus write a summary",
            "/OPUS write a summary",
        ]

        for command in deprecatedCommands {
            viewModel.isWorkspaceRefinementInFlight = false
            viewModel.inputText = command
            viewModel.sendMessage()

            XCTAssertFalse(viewModel.isWorkspaceRefinementInFlight)
        }

        XCTAssertEqual(viewModel.messages.map(\.text), deprecatedCommands)
    }

    func testExactForkCommandInPrivateConversationShowsLocalError() {
        viewModel.conversationType = "private"
        viewModel.inputText = "/fork"
        viewModel.sendMessage()

        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertEqual(
            viewModel.errorText,
            "Forking is unavailable in private conversations."
        )
        XCTAssertNil(viewModel.conversationError)
    }

    func testPopulateFromHistoryRetagsCommandListAcrossPaginationBoundary() {
        let assistantReply = HistoryResponseMessage(
            id: UUID().uuidString,
            role: "assistant",
            text: "/commands — List all available commands",
            timestamp: 2_000
        )

        viewModel.populateFromHistory(
            [assistantReply],
            hasMore: true,
            oldestTimestamp: 2_000
        )

        XCTAssertNil(viewModel.messages.first?.commandList)

        let olderUserMessage = HistoryResponseMessage(
            id: UUID().uuidString,
            role: "user",
            text: "/commands",
            timestamp: 1_000
        )

        viewModel.populateFromHistory(
            [olderUserMessage],
            hasMore: false,
            oldestTimestamp: 1_000,
            isPaginationLoad: true
        )

        XCTAssertEqual(viewModel.messages.map(\.text), [
            "/commands",
            "/commands — List all available commands",
        ])
        XCTAssertNotNil(viewModel.messages[1].commandList)
    }
}
