import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class SettingsStoreTelegramTests: XCTestCase {

    private var mockSettingsClient: MockSettingsClient!
    private var store: SettingsStore!

    override func setUp() {
        super.setUp()
        mockSettingsClient = MockSettingsClient()
        store = SettingsStore(settingsClient: mockSettingsClient)
    }

    override func tearDown() {
        store = nil
        mockSettingsClient = nil
        super.tearDown()
    }

    // MARK: - Initial State

    func testInitialTelegramState() {
        XCTAssertFalse(store.telegramHasBotToken)
        XCTAssertNil(store.telegramBotUsername)
        XCTAssertFalse(store.telegramConnected)
        XCTAssertFalse(store.telegramHasWebhookSecret)
        XCTAssertFalse(store.telegramSaveInProgress)
        XCTAssertNil(store.telegramError)
    }

    // MARK: - saveTelegramToken

    func testSaveTelegramTokenSetsSaveInProgress() {
        // Configure response so the Task completes
        mockSettingsClient.setTelegramConfigResponse = TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: true,
            hasBotToken: true,
            botUsername: nil,
            connected: false,
            hasWebhookSecret: false,
            lastError: nil,
            error: nil
        )

        store.saveTelegramToken(botToken: "123456:ABC-DEF")

        XCTAssertTrue(store.telegramSaveInProgress)
    }

    func testSaveTelegramTokenClearsError() {
        store.telegramError = "previous error"

        mockSettingsClient.setTelegramConfigResponse = TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: true,
            hasBotToken: true,
            botUsername: nil,
            connected: false,
            hasWebhookSecret: false,
            lastError: nil,
            error: nil
        )

        store.saveTelegramToken(botToken: "123456:ABC-DEF")

        XCTAssertNil(store.telegramError)
        XCTAssertTrue(store.telegramSaveInProgress)
    }

    func testSaveTelegramTokenSendsSetAction() {
        mockSettingsClient.setTelegramConfigResponse = TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: true,
            hasBotToken: true,
            botUsername: nil,
            connected: false,
            hasWebhookSecret: false,
            lastError: nil,
            error: nil
        )

        store.saveTelegramToken(botToken: "  123456:ABC-DEF  ")

        let predicate = NSPredicate { _, _ in !self.mockSettingsClient.setTelegramConfigCalls.isEmpty }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        let setCalls = mockSettingsClient.setTelegramConfigCalls.filter { $0.action == "set" }
        XCTAssertEqual(setCalls.count, 1)
        XCTAssertEqual(setCalls.first?.botToken, "123456:ABC-DEF")
    }

    func testSaveTelegramTokenTrimsWhitespace() {
        mockSettingsClient.setTelegramConfigResponse = TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: true,
            hasBotToken: true,
            botUsername: nil,
            connected: false,
            hasWebhookSecret: false,
            lastError: nil,
            error: nil
        )

        store.saveTelegramToken(botToken: "  \n  123456:TOKEN  \n  ")

        let predicate = NSPredicate { _, _ in !self.mockSettingsClient.setTelegramConfigCalls.isEmpty }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        let setCalls = mockSettingsClient.setTelegramConfigCalls.filter { $0.action == "set" }
        XCTAssertEqual(setCalls.count, 1)
        XCTAssertEqual(setCalls.first?.botToken, "123456:TOKEN")
    }

    func testSaveTelegramTokenIgnoresEmptyToken() {
        store.saveTelegramToken(botToken: "   ")

        XCTAssertFalse(store.telegramSaveInProgress)
        XCTAssertTrue(mockSettingsClient.setTelegramConfigCalls.isEmpty)
    }

    func testSaveTelegramTokenWithNilResponse() {
        // When settingsClient returns nil, saveInProgress is reset and error is set
        mockSettingsClient.setTelegramConfigResponse = nil

        store.saveTelegramToken(botToken: "123456:ABC-DEF")

        let predicate = NSPredicate { _, _ in !self.store.telegramSaveInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertFalse(store.telegramSaveInProgress)
        XCTAssertEqual(store.telegramError, "Failed to save Telegram config")
    }

    // MARK: - Successful telegram_config_response callback

    func testSuccessfulResponseUpdatesTelegramState() {
        mockSettingsClient.setTelegramConfigResponse = TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: true,
            hasBotToken: true,
            botUsername: "my_bot",
            connected: true,
            hasWebhookSecret: true,
            lastError: nil,
            error: nil
        )

        store.telegramSaveInProgress = true
        store.saveTelegramToken(botToken: "123456:ABC-DEF")

        let predicate = NSPredicate { _, _ in !self.store.telegramSaveInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertFalse(store.telegramSaveInProgress)
        XCTAssertTrue(store.telegramHasBotToken)
        XCTAssertEqual(store.telegramBotUsername, "my_bot")
        XCTAssertTrue(store.telegramConnected)
        XCTAssertTrue(store.telegramHasWebhookSecret)
        XCTAssertNil(store.telegramError)
    }

    func testSuccessfulResponseClearsPreviousError() {
        store.telegramError = "old error"
        store.telegramSaveInProgress = true

        mockSettingsClient.setTelegramConfigResponse = TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: true,
            hasBotToken: true,
            botUsername: "my_bot",
            connected: true,
            hasWebhookSecret: true,
            lastError: nil,
            error: nil
        )

        store.saveTelegramToken(botToken: "123456:ABC-DEF")

        let predicate = NSPredicate { _, _ in !self.store.telegramSaveInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertNil(store.telegramError)
    }

    // MARK: - Failure telegram_config_response callback

    func testFailureResponseSetsError() {
        store.telegramSaveInProgress = true

        mockSettingsClient.setTelegramConfigResponse = TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: false,
            hasBotToken: false,
            botUsername: nil,
            connected: false,
            hasWebhookSecret: false,
            lastError: nil,
            error: "Telegram API validation failed"
        )

        store.saveTelegramToken(botToken: "123456:ABC-DEF")

        let predicate = NSPredicate { _, _ in !self.store.telegramSaveInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertFalse(store.telegramSaveInProgress)
        XCTAssertEqual(store.telegramError, "Telegram API validation failed")
    }

    func testFailureResponseDoesNotOverwriteExistingState() {
        // Set up existing connected state
        store.telegramHasBotToken = true
        store.telegramBotUsername = "existing_bot"
        store.telegramConnected = true
        store.telegramHasWebhookSecret = true
        store.telegramSaveInProgress = true

        mockSettingsClient.setTelegramConfigResponse = TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: false,
            hasBotToken: false,
            botUsername: nil,
            connected: false,
            hasWebhookSecret: false,
            lastError: nil,
            error: "Some error"
        )

        store.saveTelegramToken(botToken: "123456:ABC-DEF")

        let predicate = NSPredicate { _, _ in !self.store.telegramSaveInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        // On failure, the handler only sets the error — it does NOT update
        // the connection state fields (hasBotToken, botUsername, etc.)
        XCTAssertTrue(store.telegramHasBotToken)
        XCTAssertEqual(store.telegramBotUsername, "existing_bot")
        XCTAssertTrue(store.telegramConnected)
        XCTAssertTrue(store.telegramHasWebhookSecret)
        XCTAssertEqual(store.telegramError, "Some error")
    }

    // MARK: - clearTelegramCredentials

    func testClearTelegramCredentialsSendsClearAction() {
        mockSettingsClient.setTelegramConfigResponse = TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: true,
            hasBotToken: false,
            botUsername: nil,
            connected: false,
            hasWebhookSecret: false,
            lastError: nil,
            error: nil
        )

        store.clearTelegramCredentials()

        let predicate = NSPredicate { _, _ in !self.mockSettingsClient.setTelegramConfigCalls.isEmpty }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        let clearCalls = mockSettingsClient.setTelegramConfigCalls.filter { $0.action == "clear" }
        XCTAssertEqual(clearCalls.count, 1)
    }

    func testClearTelegramCredentialsWithNilResponse() {
        // When settingsClient returns nil, should not crash
        mockSettingsClient.setTelegramConfigResponse = nil
        store.clearTelegramCredentials()

        let predicate = NSPredicate { _, _ in !self.store.telegramSaveInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertFalse(store.telegramSaveInProgress)
    }

    // MARK: - refreshTelegramStatus

    func testRefreshTelegramStatusCallsSettingsClient() {
        let callCountBefore = mockSettingsClient.fetchTelegramConfigCallCount

        store.refreshTelegramStatus()

        let predicate = NSPredicate { _, _ in
            self.mockSettingsClient.fetchTelegramConfigCallCount > callCountBefore
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertGreaterThan(mockSettingsClient.fetchTelegramConfigCallCount, callCountBefore)
    }

    func testRefreshTelegramStatusWithNilResponse() {
        // When settingsClient returns nil, should not crash
        mockSettingsClient.telegramConfigResponse = nil
        store.refreshTelegramStatus()

        let predicate = NSPredicate { _, _ in
            self.mockSettingsClient.fetchTelegramConfigCallCount > 0
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        // No state change expected when response is nil
        XCTAssertFalse(store.telegramHasBotToken)
    }

    // MARK: - No raw token in observable state

    func testNoRawTokenInObservableState() {
        mockSettingsClient.setTelegramConfigResponse = TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: true,
            hasBotToken: true,
            botUsername: "my_bot",
            connected: true,
            hasWebhookSecret: true,
            lastError: nil,
            error: nil
        )

        store.saveTelegramToken(botToken: "123456:SECRET-TOKEN-VALUE")

        let predicate = NSPredicate { _, _ in !self.store.telegramSaveInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        // The store should expose hasBotToken as a Bool, not the raw token
        XCTAssertTrue(store.telegramHasBotToken)

        // Verify no property contains the raw token value
        XCTAssertNotEqual(store.telegramBotUsername, "123456:SECRET-TOKEN-VALUE")
        XCTAssertNil(store.telegramError)
    }

    // MARK: - Response with partial state (only bot token, no webhook secret)

    func testResponseWithPartialState() {
        mockSettingsClient.telegramConfigResponse = TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: true,
            hasBotToken: true,
            botUsername: "partial_bot",
            connected: false,
            hasWebhookSecret: false,
            lastError: nil,
            error: nil
        )

        store.refreshTelegramStatus()

        let predicate = NSPredicate { _, _ in self.store.telegramHasBotToken }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertTrue(store.telegramHasBotToken)
        XCTAssertEqual(store.telegramBotUsername, "partial_bot")
        XCTAssertFalse(store.telegramConnected)
        XCTAssertFalse(store.telegramHasWebhookSecret)
    }

    // MARK: - Clear response resets all state

    func testClearResponseResetsAllState() {
        // Set up connected state
        store.telegramHasBotToken = true
        store.telegramBotUsername = "my_bot"
        store.telegramConnected = true
        store.telegramHasWebhookSecret = true

        // Configure clear response
        mockSettingsClient.setTelegramConfigResponse = TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: true,
            hasBotToken: false,
            botUsername: nil,
            connected: false,
            hasWebhookSecret: false,
            lastError: nil,
            error: nil
        )

        store.clearTelegramCredentials()

        let predicate = NSPredicate { _, _ in !self.store.telegramHasBotToken }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertFalse(store.telegramHasBotToken)
        XCTAssertNil(store.telegramBotUsername)
        XCTAssertFalse(store.telegramConnected)
        XCTAssertFalse(store.telegramHasWebhookSecret)
        XCTAssertNil(store.telegramError)
    }
}
