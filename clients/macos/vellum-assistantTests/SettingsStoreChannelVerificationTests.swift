import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class SettingsStoreChannelVerificationTests: XCTestCase {

    private var daemonClient: DaemonClient!
    private var sentMessages: [Any] = []
    private var store: SettingsStore!
    private let connectedAssistantIdDefaultsKey = "connectedAssistantId"
    private let testAssistantId = "ast-settings-tests"
    private var previousConnectedAssistantId: String?

    override func setUp() {
        super.setUp()
        sentMessages = []
        previousConnectedAssistantId = UserDefaults.standard.string(forKey: connectedAssistantIdDefaultsKey)
        UserDefaults.standard.set(testAssistantId, forKey: connectedAssistantIdDefaultsKey)
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
        if let previousConnectedAssistantId {
            UserDefaults.standard.set(previousConnectedAssistantId, forKey: connectedAssistantIdDefaultsKey)
        } else {
            UserDefaults.standard.removeObject(forKey: connectedAssistantIdDefaultsKey)
        }
        previousConnectedAssistantId = nil
        super.tearDown()
    }

    // MARK: - Initial State

    func testInitialVerificationStateIsNilOrFalse() {
        XCTAssertNil(store.telegramVerificationIdentity)
        XCTAssertFalse(store.telegramVerificationVerified)
        XCTAssertFalse(store.telegramVerificationInProgress)
        XCTAssertNil(store.telegramVerificationInstruction)
        XCTAssertNil(store.telegramVerificationError)

        XCTAssertNil(store.smsVerificationIdentity)
        XCTAssertFalse(store.smsVerificationVerified)
        XCTAssertFalse(store.smsVerificationInProgress)
        XCTAssertNil(store.smsVerificationInstruction)
        XCTAssertNil(store.smsVerificationError)

        XCTAssertNil(store.voiceVerificationIdentity)
        XCTAssertFalse(store.voiceVerificationVerified)
        XCTAssertFalse(store.voiceVerificationInProgress)
        XCTAssertNil(store.voiceVerificationInstruction)
        XCTAssertNil(store.voiceVerificationError)
    }

    // MARK: - refreshChannelVerificationStatus

    func testRefreshChannelVerificationStatusSendsStatusRequest() {
        // Init already sends status requests, count those first
        let verificationMessagesBefore = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let statusCountBefore = verificationMessagesBefore.filter { $0.action == "status" }.count

        store.refreshChannelVerificationStatus(channel: "telegram")

        let verificationMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let statusMessages = verificationMessages.filter { $0.action == "status" && $0.channel == "telegram" }
        XCTAssertGreaterThan(statusMessages.count, 0)

        let statusCountAfter = verificationMessages.filter { $0.action == "status" }.count
        XCTAssertEqual(statusCountAfter, statusCountBefore + 1)
    }

    // MARK: - startChannelVerification (Telegram)

    func testStartTelegramVerificationSetsInProgressAndSendsSession() {
        store.startChannelVerification(channel: "telegram")

        XCTAssertTrue(store.telegramVerificationInProgress)
        XCTAssertNil(store.telegramVerificationError)

        let verificationMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let sessionMessages = verificationMessages.filter { $0.action == "create_session" && $0.channel == "telegram" }
        XCTAssertEqual(sessionMessages.count, 1)
    }

    // MARK: - startChannelVerification (SMS)

    func testStartSmsVerificationSetsInProgressAndSendsSession() {
        store.startChannelVerification(channel: "sms")

        XCTAssertTrue(store.smsVerificationInProgress)
        XCTAssertNil(store.smsVerificationError)

        let verificationMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let sessionMessages = verificationMessages.filter { $0.action == "create_session" && $0.channel == "sms" }
        XCTAssertEqual(sessionMessages.count, 1)
    }

    // MARK: - Successful status response

    func testSuccessfulStatusResponseUpdatesTelegramVerificationState() {
        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: nil,
            instruction: nil,
            bound: true,
            guardianExternalUserId: "tg_user_123",
            channel: "telegram",
            assistantId: "self",
            guardianDeliveryChatId: "chat_456",
            error: nil
        ))

        let predicate = NSPredicate { _, _ in self.store.telegramVerificationVerified }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.telegramVerificationIdentity, "tg_user_123")
        XCTAssertTrue(store.telegramVerificationVerified)
        XCTAssertFalse(store.telegramVerificationInProgress)
        XCTAssertNil(store.telegramVerificationError)
    }

    func testSuccessfulStatusResponseUpdatesSmsVerificationState() {
        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: nil,
            instruction: nil,
            bound: true,
            guardianExternalUserId: "+15551234567",
            channel: "sms",
            assistantId: "self",
            guardianDeliveryChatId: nil,
            error: nil
        ))

        let predicate = NSPredicate { _, _ in self.store.smsVerificationVerified }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.smsVerificationIdentity, "+15551234567")
        XCTAssertTrue(store.smsVerificationVerified)
        XCTAssertFalse(store.smsVerificationInProgress)
        XCTAssertNil(store.smsVerificationError)
    }

    // MARK: - Successful create_session response provides instruction

    func testSuccessfulSessionResponseProvidesInstruction() {
        store.telegramVerificationInProgress = true

        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: "abc123",
            instruction: "Send /verify abc123 to @MyBot on Telegram",
            bound: false,
            guardianExternalUserId: nil,
            channel: "telegram",
            assistantId: "self",
            guardianDeliveryChatId: nil,
            error: nil
        ))

        let predicate = NSPredicate { _, _ in !self.store.telegramVerificationInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.telegramVerificationInstruction, "Send /verify abc123 to @MyBot on Telegram")
        XCTAssertFalse(store.telegramVerificationVerified)
        XCTAssertFalse(store.telegramVerificationInProgress)
        XCTAssertNil(store.telegramVerificationError)
    }

    func testUnverifiedStatusResponseDoesNotClearExistingTelegramInstruction() {
        store.telegramVerificationInstruction = "Send code abc123 on Telegram"

        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: nil,
            instruction: nil,
            bound: false,
            guardianExternalUserId: nil,
            channel: "telegram",
            assistantId: testAssistantId,
            guardianDeliveryChatId: nil,
            error: nil
        ))

        XCTAssertEqual(store.telegramVerificationInstruction, "Send code abc123 on Telegram")
        XCTAssertFalse(store.telegramVerificationVerified)
    }

    func testVerifiedStatusResponseClearsExistingTelegramInstruction() {
        store.telegramVerificationInstruction = "Send code abc123 on Telegram"

        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: nil,
            instruction: nil,
            bound: true,
            guardianExternalUserId: "tg_user_123",
            channel: "telegram",
            assistantId: testAssistantId,
            guardianDeliveryChatId: "chat_456",
            error: nil
        ))

        XCTAssertNil(store.telegramVerificationInstruction)
        XCTAssertTrue(store.telegramVerificationVerified)
    }

    // MARK: - Failed response sets error

    func testFailedResponseSetsTelegramError() {
        store.telegramVerificationInProgress = true

        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: false,
            secret: nil,
            instruction: nil,
            bound: nil,
            guardianExternalUserId: nil,
            channel: "telegram",
            assistantId: "self",
            guardianDeliveryChatId: nil,
            error: "Telegram bot not configured"
        ))

        let predicate = NSPredicate { _, _ in !self.store.telegramVerificationInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertFalse(store.telegramVerificationInProgress)
        XCTAssertEqual(store.telegramVerificationError, "Telegram bot not configured")
    }

    func testFailedResponseSetsSmsError() {
        store.smsVerificationInProgress = true

        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: false,
            secret: nil,
            instruction: nil,
            bound: nil,
            guardianExternalUserId: nil,
            channel: "sms",
            assistantId: "self",
            guardianDeliveryChatId: nil,
            error: "Twilio credentials missing"
        ))

        let predicate = NSPredicate { _, _ in !self.store.smsVerificationInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertFalse(store.smsVerificationInProgress)
        XCTAssertEqual(store.smsVerificationError, "Twilio credentials missing")
    }

    // MARK: - Unknown channel is silently ignored

    func testResponseForUnknownChannelIsIgnored() {
        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: nil,
            instruction: nil,
            bound: true,
            guardianExternalUserId: "user_999",
            channel: "discord",
            assistantId: "self",
            guardianDeliveryChatId: nil,
            error: nil
        ))

        // Neither telegram nor sms state should change
        XCTAssertNil(store.telegramVerificationIdentity)
        XCTAssertFalse(store.telegramVerificationVerified)
        XCTAssertNil(store.smsVerificationIdentity)
        XCTAssertFalse(store.smsVerificationVerified)
    }

    func testResponseWithNilChannelAndNoPendingStateIsIgnored() {
        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: nil,
            instruction: nil,
            bound: true,
            guardianExternalUserId: "user_999",
            channel: nil,
            assistantId: "self",
            guardianDeliveryChatId: nil,
            error: nil
        ))

        XCTAssertNil(store.telegramVerificationIdentity)
        XCTAssertFalse(store.telegramVerificationVerified)
        XCTAssertNil(store.smsVerificationIdentity)
        XCTAssertFalse(store.smsVerificationVerified)
    }

    func testResponseWithNilChannelUsesPendingVerificationChannel() {
        store.startChannelVerification(channel: "telegram")
        XCTAssertTrue(store.telegramVerificationInProgress)

        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: "abc123",
            instruction: "Send code abc123 on Telegram",
            bound: false,
            guardianExternalUserId: nil,
            channel: nil,
            assistantId: "self",
            guardianDeliveryChatId: nil,
            error: nil
        ))

        let predicate = NSPredicate { _, _ in !self.store.telegramVerificationInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.telegramVerificationInstruction, "Send code abc123 on Telegram")
        XCTAssertFalse(store.telegramVerificationInProgress)
        XCTAssertNil(store.telegramVerificationError)
    }

    func testSessionResponseStartsVerificationStatusPolling() {
        sentMessages.removeAll()
        let pollingStore = SettingsStore(
            daemonClient: daemonClient,
            verificationStatusPollInterval: 0.05,
            verificationStatusPollWindow: 2.0
        )
        pollingStore.startChannelVerification(channel: "telegram")

        let statusCountBefore = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
            .filter { $0.action == "status" && $0.channel == "telegram" }
            .count

        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: "poll-me",
            instruction: "Send code poll-me on Telegram",
            bound: false,
            guardianExternalUserId: nil,
            channel: "telegram",
            assistantId: testAssistantId,
            guardianDeliveryChatId: nil,
            error: nil
        ))

        let predicate = NSPredicate { _, _ in
            let statusCountAfter = self.sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
                .filter { $0.action == "status" && $0.channel == "telegram" }
                .count
            return statusCountAfter > statusCountBefore
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)
    }

    func testVerifiedResponseStopsVerificationStatusPolling() {
        sentMessages.removeAll()
        let pollingStore = SettingsStore(
            daemonClient: daemonClient,
            verificationStatusPollInterval: 0.05,
            verificationStatusPollWindow: 2.0
        )
        pollingStore.startChannelVerification(channel: "telegram")

        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: "poll-me",
            instruction: "Send code poll-me on Telegram",
            bound: false,
            guardianExternalUserId: nil,
            channel: "telegram",
            assistantId: testAssistantId,
            guardianDeliveryChatId: nil,
            error: nil
        ))

        let pollingStartedPredicate = NSPredicate { _, _ in
            let statusCount = self.sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
                .filter { $0.action == "status" && $0.channel == "telegram" }
                .count
            return statusCount > 1
        }
        let pollingStartedExpectation = XCTNSPredicateExpectation(predicate: pollingStartedPredicate, object: nil)
        wait(for: [pollingStartedExpectation], timeout: 2.0)

        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: nil,
            instruction: nil,
            bound: true,
            guardianExternalUserId: "tg_user_123",
            channel: "telegram",
            assistantId: testAssistantId,
            guardianDeliveryChatId: "chat_456",
            error: nil
        ))

        let settleOne = expectation(description: "settleOne")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { settleOne.fulfill() }
        wait(for: [settleOne], timeout: 1.0)

        let statusCountAfterVerification = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
            .filter { $0.action == "status" && $0.channel == "telegram" }
            .count

        let settleTwo = expectation(description: "settleTwo")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { settleTwo.fulfill() }
        wait(for: [settleTwo], timeout: 1.0)

        let statusCountFinal = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
            .filter { $0.action == "status" && $0.channel == "telegram" }
            .count

        XCTAssertEqual(statusCountFinal, statusCountAfterVerification)
    }

    // MARK: - revokeChannelVerification

    func testRevokeChannelVerificationSendsRevokeAction() {
        let verificationMessagesBefore = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let revokeCountBefore = verificationMessagesBefore.filter { $0.action == "revoke" }.count
        XCTAssertEqual(revokeCountBefore, 0)

        store.revokeChannelVerification(channel: "telegram")

        let verificationMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let revokeMessages = verificationMessages.filter { $0.action == "revoke" && $0.channel == "telegram" }
        XCTAssertEqual(revokeMessages.count, 1)
    }

    func testRevokeSmsVerificationSendsRevokeAction() {
        store.revokeChannelVerification(channel: "sms")

        let verificationMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let revokeMessages = verificationMessages.filter { $0.action == "revoke" && $0.channel == "sms" }
        XCTAssertEqual(revokeMessages.count, 1)
    }

    // MARK: - No daemon client doesn't crash

    func testNoDaemonClientDoesNotCrash() {
        let orphanStore = SettingsStore()

        // None of these should crash
        orphanStore.refreshChannelVerificationStatus(channel: "telegram")
        orphanStore.refreshChannelVerificationStatus(channel: "sms")
        orphanStore.refreshChannelVerificationStatus(channel: "phone")
        orphanStore.startChannelVerification(channel: "telegram")
        orphanStore.startChannelVerification(channel: "sms")
        orphanStore.startChannelVerification(channel: "phone")
        orphanStore.revokeChannelVerification(channel: "telegram")
        orphanStore.revokeChannelVerification(channel: "sms")
        orphanStore.revokeChannelVerification(channel: "phone")
    }

    // MARK: - Successful response clears previous error

    func testSuccessfulResponseClearsPreviousError() {
        store.telegramVerificationError = "old error"

        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: nil,
            instruction: nil,
            bound: true,
            guardianExternalUserId: "tg_user_123",
            channel: "telegram",
            assistantId: "self",
            guardianDeliveryChatId: nil,
            error: nil
        ))

        let predicate = NSPredicate { _, _ in self.store.telegramVerificationVerified }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertNil(store.telegramVerificationError)
    }

    // MARK: - Start verification clears previous error

    func testStartVerificationClearsPreviousError() {
        store.telegramVerificationError = "previous error"

        store.startChannelVerification(channel: "telegram")

        XCTAssertNil(store.telegramVerificationError)
        XCTAssertTrue(store.telegramVerificationInProgress)
    }

    // MARK: - Unknown channel in startChannelVerification is no-op

    func testStartVerificationWithUnknownChannelIsNoOp() {
        let messageCountBefore = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
            .filter { $0.action == "create_session" }.count

        store.startChannelVerification(channel: "discord")

        let messageCountAfter = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
            .filter { $0.action == "create_session" }.count
        XCTAssertEqual(messageCountAfter, messageCountBefore)
    }

    // MARK: - Init sends status requests for both channels

    func testInitSendsVerificationStatusRequestsForAllChannels() {
        let verificationMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let statusMessages = verificationMessages.filter { $0.action == "status" }

        let telegramStatus = statusMessages.filter { $0.channel == "telegram" }
        let smsStatus = statusMessages.filter { $0.channel == "sms" }
        let voiceStatus = statusMessages.filter { $0.channel == "phone" }

        XCTAssertEqual(telegramStatus.count, 1)
        XCTAssertEqual(smsStatus.count, 1)
        XCTAssertEqual(voiceStatus.count, 1)
    }

    func testStatusPollResponseDoesNotClearVerificationSessionPending() {
        store.startChannelVerification(channel: "telegram")
        XCTAssertTrue(store.telegramVerificationInProgress)

        // Simulate a status poll response (no secret, no instruction, not bound)
        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: nil,
            instruction: nil,
            bound: false,
            guardianExternalUserId: nil,
            channel: "telegram",
            assistantId: testAssistantId,
            guardianDeliveryChatId: nil,
            error: nil
        ))

        // A session response (with secret+instruction) should still clear the pending state
        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: "abc123",
            instruction: "Send code abc123 on Telegram",
            bound: false,
            guardianExternalUserId: nil,
            channel: "telegram",
            assistantId: testAssistantId,
            guardianDeliveryChatId: nil,
            error: nil
        ))

        XCTAssertEqual(store.telegramVerificationInstruction, "Send code abc123 on Telegram")
        XCTAssertFalse(store.telegramVerificationInProgress)
    }

    // MARK: - Revoke clears instruction

    func testRevokeTelegramVerificationClearsInstruction() {
        store.telegramVerificationInstruction = "Send code abc123 on Telegram"

        store.revokeChannelVerification(channel: "telegram")

        XCTAssertNil(store.telegramVerificationInstruction)
    }

    func testRevokeSmsVerificationClearsInstruction() {
        store.smsVerificationInstruction = "Send code abc123 via SMS"

        store.revokeChannelVerification(channel: "sms")

        XCTAssertNil(store.smsVerificationInstruction)
    }

    // MARK: - Timeout clears instruction

    func testTimeoutClearsTelegramInstruction() {
        sentMessages.removeAll()
        let shortTimeoutStore = SettingsStore(
            daemonClient: daemonClient,
            verificationSessionTimeoutDuration: 0.15,
            verificationStatusPollInterval: 0.05,
            verificationStatusPollWindow: 2.0
        )

        shortTimeoutStore.startChannelVerification(channel: "telegram")

        // Manually set instruction to simulate a previous session's stale text
        // that persists when a new session times out before the daemon responds.
        shortTimeoutStore.telegramVerificationInstruction = "Send code stale on Telegram"

        // Wait for the timeout to fire
        let predicate = NSPredicate { _, _ in
            shortTimeoutStore.telegramVerificationError != nil
        }
        let timeoutExpectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [timeoutExpectation], timeout: 2.0)

        XCTAssertNil(shortTimeoutStore.telegramVerificationInstruction)
        XCTAssertFalse(shortTimeoutStore.telegramVerificationInProgress)
    }

    func testTimeoutClearsSmsInstruction() {
        sentMessages.removeAll()
        let shortTimeoutStore = SettingsStore(
            daemonClient: daemonClient,
            verificationSessionTimeoutDuration: 0.15,
            verificationStatusPollInterval: 0.05,
            verificationStatusPollWindow: 2.0
        )

        shortTimeoutStore.startChannelVerification(channel: "sms")

        // Manually set instruction to simulate a previous session's stale text
        shortTimeoutStore.smsVerificationInstruction = "Send code stale via SMS"

        // Wait for the timeout to fire
        let predicate = NSPredicate { _, _ in
            shortTimeoutStore.smsVerificationError != nil
        }
        let timeoutExpectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [timeoutExpectation], timeout: 2.0)

        XCTAssertNil(shortTimeoutStore.smsVerificationInstruction)
        XCTAssertFalse(shortTimeoutStore.smsVerificationInProgress)
    }

    // MARK: - Cross-channel timeout isolation

    func testResponseForChannelADoesNotCancelTimeoutForChannelB() {
        // Use a short timeout so the test completes quickly
        sentMessages.removeAll()
        let shortTimeoutStore = SettingsStore(
            daemonClient: daemonClient,
            verificationSessionTimeoutDuration: 0.3,
            verificationStatusPollInterval: 0.05,
            verificationStatusPollWindow: 2.0
        )

        // Start SMS verification — this arms the timeout for SMS
        shortTimeoutStore.startChannelVerification(channel: "sms")
        XCTAssertTrue(shortTimeoutStore.smsVerificationInProgress)

        // A telegram response arrives — this must NOT cancel the SMS timeout
        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: nil,
            instruction: nil,
            bound: true,
            guardianExternalUserId: "tg_user_123",
            channel: "telegram",
            assistantId: testAssistantId,
            guardianDeliveryChatId: "chat_456",
            error: nil
        ))

        // SMS should still be in progress right after the telegram response
        XCTAssertTrue(shortTimeoutStore.smsVerificationInProgress)
        XCTAssertNil(shortTimeoutStore.smsVerificationError)

        // Wait for the SMS timeout to fire (0.3s + buffer)
        let predicate = NSPredicate { _, _ in !shortTimeoutStore.smsVerificationInProgress }
        let timeoutExpectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [timeoutExpectation], timeout: 2.0)

        // The SMS timeout should have fired, clearing the spinner and setting an error
        XCTAssertFalse(shortTimeoutStore.smsVerificationInProgress)
        XCTAssertEqual(shortTimeoutStore.smsVerificationError, "Timed out waiting for verification instructions. Try again.")
    }

    // MARK: - Voice Channel Verification

    func testStartVoiceVerificationSetsInProgressAndSendsSession() {
        store.startChannelVerification(channel: "phone")

        XCTAssertTrue(store.voiceVerificationInProgress)
        XCTAssertNil(store.voiceVerificationError)

        let verificationMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let sessionMessages = verificationMessages.filter { $0.action == "create_session" && $0.channel == "phone" }
        XCTAssertEqual(sessionMessages.count, 1)
    }

    func testSuccessfulStatusResponseUpdatesVoiceVerificationState() {
        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: nil,
            instruction: nil,
            bound: true,
            guardianExternalUserId: "+15559876543",
            channel: "phone",
            assistantId: "self",
            guardianDeliveryChatId: nil,
            error: nil
        ))

        let predicate = NSPredicate { _, _ in self.store.voiceVerificationVerified }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.voiceVerificationIdentity, "+15559876543")
        XCTAssertTrue(store.voiceVerificationVerified)
        XCTAssertFalse(store.voiceVerificationInProgress)
        XCTAssertNil(store.voiceVerificationError)
    }

    func testFailedResponseSetsVoiceError() {
        store.voiceVerificationInProgress = true

        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: false,
            secret: nil,
            instruction: nil,
            bound: nil,
            guardianExternalUserId: nil,
            channel: "phone",
            assistantId: "self",
            guardianDeliveryChatId: nil,
            error: "Voice channel not configured"
        ))

        let predicate = NSPredicate { _, _ in !self.store.voiceVerificationInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertFalse(store.voiceVerificationInProgress)
        XCTAssertEqual(store.voiceVerificationError, "Voice channel not configured")
    }

    func testRevokeVoiceVerificationSendsRevokeAction() {
        store.revokeChannelVerification(channel: "phone")

        let verificationMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let revokeMessages = verificationMessages.filter { $0.action == "revoke" && $0.channel == "phone" }
        XCTAssertEqual(revokeMessages.count, 1)
    }

    func testRevokeVoiceVerificationClearsInstruction() {
        store.voiceVerificationInstruction = "Call and say 123456"

        store.revokeChannelVerification(channel: "phone")

        XCTAssertNil(store.voiceVerificationInstruction)
    }

    func testTimeoutClearsVoiceInstruction() {
        sentMessages.removeAll()
        let shortTimeoutStore = SettingsStore(
            daemonClient: daemonClient,
            verificationSessionTimeoutDuration: 0.15,
            verificationStatusPollInterval: 0.05,
            verificationStatusPollWindow: 2.0
        )

        shortTimeoutStore.startChannelVerification(channel: "phone")

        shortTimeoutStore.voiceVerificationInstruction = "Call and say 123456"

        let predicate = NSPredicate { _, _ in
            shortTimeoutStore.voiceVerificationError != nil
        }
        let timeoutExpectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [timeoutExpectation], timeout: 2.0)

        XCTAssertNil(shortTimeoutStore.voiceVerificationInstruction)
        XCTAssertFalse(shortTimeoutStore.voiceVerificationInProgress)
    }

    func testVoiceResponseDoesNotAffectTelegramOrSmsState() {
        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: nil,
            instruction: nil,
            bound: true,
            guardianExternalUserId: "+15559876543",
            channel: "phone",
            assistantId: "self",
            guardianDeliveryChatId: nil,
            error: nil
        ))

        let predicate = NSPredicate { _, _ in self.store.voiceVerificationVerified }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        // Telegram and SMS should be unaffected
        XCTAssertNil(store.telegramVerificationIdentity)
        XCTAssertFalse(store.telegramVerificationVerified)
        XCTAssertNil(store.smsVerificationIdentity)
        XCTAssertFalse(store.smsVerificationVerified)
    }

    // MARK: - Outbound Verification: startOutboundVerification

    func testStartOutboundVerificationSendsCorrectIPCMessage() {
        store.startOutboundVerification(channel: "sms", destination: "+15551234567")

        let verificationMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let outboundMessages = verificationMessages.filter { $0.action == "create_session" && $0.channel == "sms" }
        XCTAssertEqual(outboundMessages.count, 1)
        XCTAssertEqual(outboundMessages.first?.destination, "+15551234567")
        XCTAssertTrue(store.smsVerificationInProgress)
    }

    func testStartOutboundVerificationClearsExistingOutboundState() {
        store.smsOutboundSessionId = "old-session"
        store.smsOutboundExpiresAt = Date()
        store.smsOutboundSendCount = 3

        store.startOutboundVerification(channel: "sms", destination: "+15551234567")

        XCTAssertNil(store.smsOutboundSessionId)
        XCTAssertNil(store.smsOutboundExpiresAt)
        XCTAssertEqual(store.smsOutboundSendCount, 0)
    }

    func testStartOutboundTelegramVerificationSendsCorrectMessage() {
        store.startOutboundVerification(channel: "telegram", destination: "@guardian_user")

        let verificationMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let outboundMessages = verificationMessages.filter { $0.action == "create_session" && $0.channel == "telegram" }
        XCTAssertEqual(outboundMessages.count, 1)
        XCTAssertEqual(outboundMessages.first?.destination, "@guardian_user")
        XCTAssertTrue(store.telegramVerificationInProgress)
    }

    // MARK: - Outbound Verification: response populates session state

    func testOutboundResponsePopulatesSessionState() {
        store.smsVerificationInProgress = true

        let expiresMs = Int(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)
        let nextResendMs = Int(Date().addingTimeInterval(30).timeIntervalSince1970 * 1000)

        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            channel: "sms",
            verificationSessionId: "sess-123",
            expiresAt: expiresMs,
            nextResendAt: nextResendMs,
            sendCount: 1
        ))

        let predicate = NSPredicate { _, _ in self.store.smsOutboundSessionId == "sess-123" }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.smsOutboundSessionId, "sess-123")
        XCTAssertNotNil(store.smsOutboundExpiresAt)
        XCTAssertNotNil(store.smsOutboundNextResendAt)
        XCTAssertEqual(store.smsOutboundSendCount, 1)
    }

    // MARK: - Outbound Verification: Telegram bootstrap URL

    func testTelegramBootstrapUrlIsStored() {
        store.telegramVerificationInProgress = true

        let expiresMs = Int(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)

        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            channel: "telegram",
            verificationSessionId: "tg-sess-456",
            expiresAt: expiresMs,
            sendCount: 1,
            telegramBootstrapUrl: "https://t.me/MyBot?start=verify_abc123"
        ))

        let predicate = NSPredicate { _, _ in self.store.telegramBootstrapUrl != nil }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.telegramBootstrapUrl, "https://t.me/MyBot?start=verify_abc123")
        XCTAssertEqual(store.telegramOutboundSessionId, "tg-sess-456")
    }

    // MARK: - Outbound Verification: resend sends correct message

    func testResendOutboundSendsCorrectIPCMessage() {
        let verificationMessagesBefore = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let resendCountBefore = verificationMessagesBefore.filter { $0.action == "resend_session" }.count

        store.resendOutboundVerification(channel: "sms")

        let verificationMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let resendMessages = verificationMessages.filter { $0.action == "resend_session" && $0.channel == "sms" }
        XCTAssertEqual(resendMessages.count, resendCountBefore + 1)
    }

    // MARK: - Outbound Verification: cancel clears state

    func testCancelOutboundClearsState() {
        store.smsOutboundSessionId = "sess-to-cancel"
        store.smsOutboundExpiresAt = Date().addingTimeInterval(300)
        store.smsOutboundSendCount = 2
        store.smsVerificationInProgress = true

        store.cancelOutboundVerification(channel: "sms")

        XCTAssertNil(store.smsOutboundSessionId)
        XCTAssertNil(store.smsOutboundExpiresAt)
        XCTAssertNil(store.smsOutboundNextResendAt)
        XCTAssertEqual(store.smsOutboundSendCount, 0)
        XCTAssertFalse(store.smsVerificationInProgress)

        let verificationMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let cancelMessages = verificationMessages.filter { $0.action == "cancel_session" && $0.channel == "sms" }
        XCTAssertEqual(cancelMessages.count, 1)
    }

    func testCancelOutboundTelegramClearsBootstrapUrl() {
        store.telegramOutboundSessionId = "tg-sess-cancel"
        store.telegramBootstrapUrl = "https://t.me/MyBot?start=verify_abc"

        store.cancelOutboundVerification(channel: "telegram")

        XCTAssertNil(store.telegramOutboundSessionId)
        XCTAssertNil(store.telegramBootstrapUrl)
    }

    // MARK: - Outbound Verification: verified response clears outbound state

    func testVerifiedResponseClearsOutboundState() {
        store.smsOutboundSessionId = "sess-pending"
        store.smsOutboundExpiresAt = Date().addingTimeInterval(300)
        store.smsOutboundSendCount = 1

        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            bound: true,
            guardianExternalUserId: "+15551234567",
            channel: "sms",
            assistantId: "self"
        ))

        let predicate = NSPredicate { _, _ in self.store.smsVerificationVerified }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertNil(store.smsOutboundSessionId)
        XCTAssertNil(store.smsOutboundExpiresAt)
        XCTAssertEqual(store.smsOutboundSendCount, 0)
        XCTAssertTrue(store.smsVerificationVerified)
    }

    // MARK: - Outbound Verification: initial state is nil

    func testInitialOutboundStateIsNilOrZero() {
        XCTAssertNil(store.telegramOutboundSessionId)
        XCTAssertNil(store.telegramOutboundExpiresAt)
        XCTAssertNil(store.telegramOutboundNextResendAt)
        XCTAssertEqual(store.telegramOutboundSendCount, 0)
        XCTAssertNil(store.telegramBootstrapUrl)

        XCTAssertNil(store.smsOutboundSessionId)
        XCTAssertNil(store.smsOutboundExpiresAt)
        XCTAssertNil(store.smsOutboundNextResendAt)
        XCTAssertEqual(store.smsOutboundSendCount, 0)

        XCTAssertNil(store.voiceOutboundSessionId)
        XCTAssertNil(store.voiceOutboundExpiresAt)
        XCTAssertNil(store.voiceOutboundNextResendAt)
        XCTAssertEqual(store.voiceOutboundSendCount, 0)
    }
}
