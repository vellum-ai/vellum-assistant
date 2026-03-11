import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class SettingsStoreTelegramTests: XCTestCase {

    private var daemonClient: DaemonClient!
    private var sentMessages: [Any] = []
    private var store: SettingsStore!

    override func setUp() {
        super.setUp()
        sentMessages = []
        daemonClient = DaemonClient()
        daemonClient.isConnected = true
        daemonClient.sendOverride = { [weak self] message in
            self?.sentMessages.append(message)
        }
        store = SettingsStore(daemonClient: daemonClient)
    }

    override func tearDown() {
        store = nil
        daemonClient = nil
        sentMessages = []
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
        store.saveTelegramToken(botToken: "123456:ABC-DEF")

        XCTAssertTrue(store.telegramSaveInProgress)
    }

    func testSaveTelegramTokenClearsError() {
        store.telegramError = "previous error"

        store.saveTelegramToken(botToken: "123456:ABC-DEF")

        XCTAssertNil(store.telegramError)
        XCTAssertTrue(store.telegramSaveInProgress)
    }

    func testSaveTelegramTokenSendsSetAction() {
        store.saveTelegramToken(botToken: "  123456:ABC-DEF  ")

        // Init sends model_get, telegram get, vercel get.
        // saveTelegramToken adds a telegram_config set message.
        let telegramMessages = sentMessages.compactMap { $0 as? TelegramConfigRequestMessage }
        // Should have at least the init "get" + the "set" call
        let setMessages = telegramMessages.filter { $0.action == "set" }
        XCTAssertEqual(setMessages.count, 1)
        XCTAssertEqual(setMessages.first?.botToken, "123456:ABC-DEF")
    }

    func testSaveTelegramTokenTrimsWhitespace() {
        store.saveTelegramToken(botToken: "  \n  123456:TOKEN  \n  ")

        let telegramMessages = sentMessages.compactMap { $0 as? TelegramConfigRequestMessage }
        let setMessages = telegramMessages.filter { $0.action == "set" }
        XCTAssertEqual(setMessages.count, 1)
        XCTAssertEqual(setMessages.first?.botToken, "123456:TOKEN")
    }

    func testSaveTelegramTokenIgnoresEmptyToken() {
        store.saveTelegramToken(botToken: "   ")

        XCTAssertFalse(store.telegramSaveInProgress)
        let telegramMessages = sentMessages.compactMap { $0 as? TelegramConfigRequestMessage }
        let setMessages = telegramMessages.filter { $0.action == "set" }
        XCTAssertTrue(setMessages.isEmpty)
    }

    func testSaveTelegramTokenWithNilDaemonClient() {
        // Create a store without a daemon client
        let orphanStore = SettingsStore()

        orphanStore.saveTelegramToken(botToken: "123456:ABC-DEF")

        // Should reset saveInProgress since there is no daemon client
        XCTAssertFalse(orphanStore.telegramSaveInProgress)
    }

    // MARK: - Successful telegram_config_response callback

    func testSuccessfulResponseUpdatesTelegramState() {
        store.telegramSaveInProgress = true

        // Simulate the daemon sending a successful response
        daemonClient.onTelegramConfigResponse?(TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: true,
            hasBotToken: true,
            botUsername: "my_bot",
            connected: true,
            hasWebhookSecret: true,
            lastError: nil,
            error: nil
        ))

        // Wait for the callback to complete on MainActor
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
        store.telegramSaveInProgress = true
        store.telegramError = "old error"

        daemonClient.onTelegramConfigResponse?(TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: true,
            hasBotToken: true,
            botUsername: "my_bot",
            connected: true,
            hasWebhookSecret: true,
            lastError: nil,
            error: nil
        ))

        let predicate = NSPredicate { _, _ in !self.store.telegramSaveInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertNil(store.telegramError)
    }

    // MARK: - Failure telegram_config_response callback

    func testFailureResponseSetsError() {
        store.telegramSaveInProgress = true

        daemonClient.onTelegramConfigResponse?(TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: false,
            hasBotToken: false,
            botUsername: nil,
            connected: false,
            hasWebhookSecret: false,
            lastError: nil,
            error: "Telegram API validation failed"
        ))

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

        daemonClient.onTelegramConfigResponse?(TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: false,
            hasBotToken: false,
            botUsername: nil,
            connected: false,
            hasWebhookSecret: false,
            lastError: nil,
            error: "Some error"
        ))

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
        let telegramMessagesBefore = sentMessages.compactMap { $0 as? TelegramConfigRequestMessage }
        let clearBefore = telegramMessagesBefore.filter { $0.action == "clear" }
        XCTAssertTrue(clearBefore.isEmpty)

        store.clearTelegramCredentials()

        let telegramMessages = sentMessages.compactMap { $0 as? TelegramConfigRequestMessage }
        let clearMessages = telegramMessages.filter { $0.action == "clear" }
        XCTAssertEqual(clearMessages.count, 1)
    }

    func testClearTelegramCredentialsWithNilDaemonClient() {
        let orphanStore = SettingsStore()
        // Should not crash
        orphanStore.clearTelegramCredentials()
    }

    // MARK: - refreshTelegramStatus

    func testRefreshTelegramStatusSendsGetAction() {
        // Init already sends a "get", so count those first
        let telegramMessagesBefore = sentMessages.compactMap { $0 as? TelegramConfigRequestMessage }
        let getCountBefore = telegramMessagesBefore.filter { $0.action == "get" }.count

        store.refreshTelegramStatus()

        let telegramMessages = sentMessages.compactMap { $0 as? TelegramConfigRequestMessage }
        let getCountAfter = telegramMessages.filter { $0.action == "get" }.count
        XCTAssertEqual(getCountAfter, getCountBefore + 1)
    }

    func testRefreshTelegramStatusWithNilDaemonClient() {
        let orphanStore = SettingsStore()
        // Should not crash
        orphanStore.refreshTelegramStatus()
    }

    // MARK: - No raw token in observable state

    func testNoRawTokenInObservableState() {
        // Simulate a successful save flow
        store.saveTelegramToken(botToken: "123456:SECRET-TOKEN-VALUE")

        daemonClient.onTelegramConfigResponse?(TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: true,
            hasBotToken: true,
            botUsername: "my_bot",
            connected: true,
            hasWebhookSecret: true,
            lastError: nil,
            error: nil
        ))

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
        daemonClient.onTelegramConfigResponse?(TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: true,
            hasBotToken: true,
            botUsername: "partial_bot",
            connected: false,
            hasWebhookSecret: false,
            lastError: nil,
            error: nil
        ))

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

        // Simulate clear response
        daemonClient.onTelegramConfigResponse?(TelegramConfigResponseMessage(
            type: "telegram_config_response",
            success: true,
            hasBotToken: false,
            botUsername: nil,
            connected: false,
            hasWebhookSecret: false,
            lastError: nil,
            error: nil
        ))

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
