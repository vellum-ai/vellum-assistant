import XCTest
@testable import VellumAssistantShared

@MainActor
final class ChatViewModelSlashCommandTests: XCTestCase {

    private final class StubSettingsClient: SettingsClientProtocol {
        var fetchModelInfoCallCount = 0
        var modelInfoResponse: ModelInfoMessage?

        func fetchVercelConfig() async -> VercelApiConfigResponseMessage? { nil }

        func fetchModelInfo() async -> ModelInfoMessage? {
            fetchModelInfoCallCount += 1
            return modelInfoResponse
        }

        func setModel(model: String, provider: String?) async -> ModelInfoMessage? { nil }

        func setImageGenModel(modelId: String) async -> ModelInfoMessage? { nil }

        func fetchTelegramConfig() async -> TelegramConfigResponseMessage? { nil }

        func setTelegramConfig(
            action: String,
            botToken: String?,
            commands: [TelegramConfigRequestCommand]?
        ) async -> TelegramConfigResponseMessage? { nil }

        func setSlackWebhookConfig(action: String, webhookUrl: String?) async -> Bool { false }

        func fetchChannelVerificationStatus(channel: String) async -> ChannelVerificationSessionResponseMessage? { nil }
    }

    private var daemonClient: MockDaemonClient!
    private var settingsClient: StubSettingsClient!
    private var viewModel: ChatViewModel!

    override func setUp() {
        super.setUp()
        daemonClient = MockDaemonClient()
        daemonClient.isConnected = true
        settingsClient = StubSettingsClient()
        viewModel = ChatViewModel(
            daemonClient: daemonClient,
            settingsClient: settingsClient
        )
        viewModel.conversationId = "sess-1"
    }

    override func tearDown() {
        viewModel = nil
        settingsClient = nil
        daemonClient = nil
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

    func testUnknownSlashCommandsUseWorkspaceRefinementWhenSurfaceIsActive() {
        viewModel.activeSurfaceId = "surface-1"
        viewModel.isChatDockedToSide = false

        viewModel.inputText = "/foo"
        viewModel.sendMessage()

        XCTAssertTrue(viewModel.isWorkspaceRefinementInFlight)
        XCTAssertEqual(viewModel.messages.count, 0)

        viewModel.isWorkspaceRefinementInFlight = false
        viewModel.inputText = "/model"
        viewModel.sendMessage()

        XCTAssertTrue(viewModel.isWorkspaceRefinementInFlight)
        XCTAssertEqual(viewModel.messages.count, 0)
    }
}
