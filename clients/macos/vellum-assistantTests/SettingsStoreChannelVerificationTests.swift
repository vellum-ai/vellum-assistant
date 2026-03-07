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

    func testInitialGuardianStateIsNilOrFalse() {
        XCTAssertNil(store.telegramGuardianIdentity)
        XCTAssertFalse(store.telegramGuardianVerified)
        XCTAssertFalse(store.telegramGuardianVerificationInProgress)
        XCTAssertNil(store.telegramGuardianInstruction)
        XCTAssertNil(store.telegramGuardianError)

        XCTAssertNil(store.smsGuardianIdentity)
        XCTAssertFalse(store.smsGuardianVerified)
        XCTAssertFalse(store.smsGuardianVerificationInProgress)
        XCTAssertNil(store.smsGuardianInstruction)
        XCTAssertNil(store.smsGuardianError)

        XCTAssertNil(store.voiceGuardianIdentity)
        XCTAssertFalse(store.voiceGuardianVerified)
        XCTAssertFalse(store.voiceGuardianVerificationInProgress)
        XCTAssertNil(store.voiceGuardianInstruction)
        XCTAssertNil(store.voiceGuardianError)
    }

    // MARK: - refreshChannelGuardianStatus

    func testRefreshChannelGuardianStatusSendsStatusRequest() {
        // Init already sends status requests, count those first
        let guardianMessagesBefore = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let statusCountBefore = guardianMessagesBefore.filter { $0.action == "status" }.count

        store.refreshChannelGuardianStatus(channel: "telegram")

        let guardianMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let statusMessages = guardianMessages.filter { $0.action == "status" && $0.channel == "telegram" }
        XCTAssertGreaterThan(statusMessages.count, 0)

        let statusCountAfter = guardianMessages.filter { $0.action == "status" }.count
        XCTAssertEqual(statusCountAfter, statusCountBefore + 1)
    }

    // MARK: - startChannelGuardianVerification (Telegram)

    func testStartTelegramVerificationSetsInProgressAndSendsChallenge() {
        store.startChannelGuardianVerification(channel: "telegram")

        XCTAssertTrue(store.telegramGuardianVerificationInProgress)
        XCTAssertNil(store.telegramGuardianError)

        let guardianMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let challengeMessages = guardianMessages.filter { $0.action == "create_session" && $0.channel == "telegram" }
        XCTAssertEqual(challengeMessages.count, 1)
    }

    // MARK: - startChannelGuardianVerification (SMS)

    func testStartSmsVerificationSetsInProgressAndSendsChallenge() {
        store.startChannelGuardianVerification(channel: "sms")

        XCTAssertTrue(store.smsGuardianVerificationInProgress)
        XCTAssertNil(store.smsGuardianError)

        let guardianMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let challengeMessages = guardianMessages.filter { $0.action == "create_session" && $0.channel == "sms" }
        XCTAssertEqual(challengeMessages.count, 1)
    }

    // MARK: - Successful status response

    func testSuccessfulStatusResponseUpdatesTelegramGuardianState() {
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

        let predicate = NSPredicate { _, _ in self.store.telegramGuardianVerified }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.telegramGuardianIdentity, "tg_user_123")
        XCTAssertTrue(store.telegramGuardianVerified)
        XCTAssertFalse(store.telegramGuardianVerificationInProgress)
        XCTAssertNil(store.telegramGuardianError)
    }

    func testSuccessfulStatusResponseUpdatesSmsGuardianState() {
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

        let predicate = NSPredicate { _, _ in self.store.smsGuardianVerified }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.smsGuardianIdentity, "+15551234567")
        XCTAssertTrue(store.smsGuardianVerified)
        XCTAssertFalse(store.smsGuardianVerificationInProgress)
        XCTAssertNil(store.smsGuardianError)
    }

    // MARK: - Successful create_session response provides instruction

    func testSuccessfulChallengeResponseProvidesInstruction() {
        store.telegramGuardianVerificationInProgress = true

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

        let predicate = NSPredicate { _, _ in !self.store.telegramGuardianVerificationInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.telegramGuardianInstruction, "Send /verify abc123 to @MyBot on Telegram")
        XCTAssertFalse(store.telegramGuardianVerified)
        XCTAssertFalse(store.telegramGuardianVerificationInProgress)
        XCTAssertNil(store.telegramGuardianError)
    }

    func testUnverifiedStatusResponseDoesNotClearExistingTelegramInstruction() {
        store.telegramGuardianInstruction = "Send code abc123 on Telegram"

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

        XCTAssertEqual(store.telegramGuardianInstruction, "Send code abc123 on Telegram")
        XCTAssertFalse(store.telegramGuardianVerified)
    }

    func testVerifiedStatusResponseClearsExistingTelegramInstruction() {
        store.telegramGuardianInstruction = "Send code abc123 on Telegram"

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

        XCTAssertNil(store.telegramGuardianInstruction)
        XCTAssertTrue(store.telegramGuardianVerified)
    }

    // MARK: - Failed response sets error

    func testFailedResponseSetsTelegramError() {
        store.telegramGuardianVerificationInProgress = true

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

        let predicate = NSPredicate { _, _ in !self.store.telegramGuardianVerificationInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertFalse(store.telegramGuardianVerificationInProgress)
        XCTAssertEqual(store.telegramGuardianError, "Telegram bot not configured")
    }

    func testFailedResponseSetsSmsError() {
        store.smsGuardianVerificationInProgress = true

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

        let predicate = NSPredicate { _, _ in !self.store.smsGuardianVerificationInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertFalse(store.smsGuardianVerificationInProgress)
        XCTAssertEqual(store.smsGuardianError, "Twilio credentials missing")
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
        XCTAssertNil(store.telegramGuardianIdentity)
        XCTAssertFalse(store.telegramGuardianVerified)
        XCTAssertNil(store.smsGuardianIdentity)
        XCTAssertFalse(store.smsGuardianVerified)
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

        XCTAssertNil(store.telegramGuardianIdentity)
        XCTAssertFalse(store.telegramGuardianVerified)
        XCTAssertNil(store.smsGuardianIdentity)
        XCTAssertFalse(store.smsGuardianVerified)
    }

    func testResponseWithNilChannelUsesPendingVerificationChannel() {
        store.startChannelGuardianVerification(channel: "telegram")
        XCTAssertTrue(store.telegramGuardianVerificationInProgress)

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

        let predicate = NSPredicate { _, _ in !self.store.telegramGuardianVerificationInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.telegramGuardianInstruction, "Send code abc123 on Telegram")
        XCTAssertFalse(store.telegramGuardianVerificationInProgress)
        XCTAssertNil(store.telegramGuardianError)
    }

    func testChallengeResponseStartsGuardianStatusPolling() {
        sentMessages.removeAll()
        let pollingStore = SettingsStore(
            daemonClient: daemonClient,
            guardianStatusPollInterval: 0.05,
            guardianStatusPollWindow: 2.0
        )
        pollingStore.startChannelGuardianVerification(channel: "telegram")

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

    func testVerifiedResponseStopsGuardianStatusPolling() {
        sentMessages.removeAll()
        let pollingStore = SettingsStore(
            daemonClient: daemonClient,
            guardianStatusPollInterval: 0.05,
            guardianStatusPollWindow: 2.0
        )
        pollingStore.startChannelGuardianVerification(channel: "telegram")

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

    // MARK: - revokeChannelGuardian

    func testRevokeChannelGuardianSendsRevokeAction() {
        let guardianMessagesBefore = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let revokeCountBefore = guardianMessagesBefore.filter { $0.action == "revoke" }.count
        XCTAssertEqual(revokeCountBefore, 0)

        store.revokeChannelGuardian(channel: "telegram")

        let guardianMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let revokeMessages = guardianMessages.filter { $0.action == "revoke" && $0.channel == "telegram" }
        XCTAssertEqual(revokeMessages.count, 1)
    }

    func testRevokeSmsGuardianSendsRevokeAction() {
        store.revokeChannelGuardian(channel: "sms")

        let guardianMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let revokeMessages = guardianMessages.filter { $0.action == "revoke" && $0.channel == "sms" }
        XCTAssertEqual(revokeMessages.count, 1)
    }

    // MARK: - No daemon client doesn't crash

    func testNoDaemonClientDoesNotCrash() {
        let orphanStore = SettingsStore()

        // None of these should crash
        orphanStore.refreshChannelGuardianStatus(channel: "telegram")
        orphanStore.refreshChannelGuardianStatus(channel: "sms")
        orphanStore.refreshChannelGuardianStatus(channel: "voice")
        orphanStore.startChannelGuardianVerification(channel: "telegram")
        orphanStore.startChannelGuardianVerification(channel: "sms")
        orphanStore.startChannelGuardianVerification(channel: "voice")
        orphanStore.revokeChannelGuardian(channel: "telegram")
        orphanStore.revokeChannelGuardian(channel: "sms")
        orphanStore.revokeChannelGuardian(channel: "voice")
    }

    // MARK: - Successful response clears previous error

    func testSuccessfulResponseClearsPreviousError() {
        store.telegramGuardianError = "old error"

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

        let predicate = NSPredicate { _, _ in self.store.telegramGuardianVerified }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertNil(store.telegramGuardianError)
    }

    // MARK: - Start verification clears previous error

    func testStartVerificationClearsPreviousError() {
        store.telegramGuardianError = "previous error"

        store.startChannelGuardianVerification(channel: "telegram")

        XCTAssertNil(store.telegramGuardianError)
        XCTAssertTrue(store.telegramGuardianVerificationInProgress)
    }

    // MARK: - Unknown channel in startChannelGuardianVerification is no-op

    func testStartVerificationWithUnknownChannelIsNoOp() {
        let messageCountBefore = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
            .filter { $0.action == "create_session" }.count

        store.startChannelGuardianVerification(channel: "discord")

        let messageCountAfter = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
            .filter { $0.action == "create_session" }.count
        XCTAssertEqual(messageCountAfter, messageCountBefore)
    }

    // MARK: - Init sends status requests for both channels

    func testInitSendsGuardianStatusRequestsForAllChannels() {
        let guardianMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let statusMessages = guardianMessages.filter { $0.action == "status" }

        let telegramStatus = statusMessages.filter { $0.channel == "telegram" }
        let smsStatus = statusMessages.filter { $0.channel == "sms" }
        let voiceStatus = statusMessages.filter { $0.channel == "voice" }

        XCTAssertEqual(telegramStatus.count, 1)
        XCTAssertEqual(smsStatus.count, 1)
        XCTAssertEqual(voiceStatus.count, 1)
    }

    func testStatusPollResponseDoesNotClearGuardianChallengePending() {
        store.startChannelGuardianVerification(channel: "telegram")
        XCTAssertTrue(store.telegramGuardianVerificationInProgress)

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

        // A challenge response (with secret+instruction) should still clear the pending state
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

        XCTAssertEqual(store.telegramGuardianInstruction, "Send code abc123 on Telegram")
        XCTAssertFalse(store.telegramGuardianVerificationInProgress)
    }

    // MARK: - Revoke clears instruction

    func testRevokeTelegramGuardianClearsInstruction() {
        store.telegramGuardianInstruction = "Send code abc123 on Telegram"

        store.revokeChannelGuardian(channel: "telegram")

        XCTAssertNil(store.telegramGuardianInstruction)
    }

    func testRevokeSmsGuardianClearsInstruction() {
        store.smsGuardianInstruction = "Send code abc123 via SMS"

        store.revokeChannelGuardian(channel: "sms")

        XCTAssertNil(store.smsGuardianInstruction)
    }

    // MARK: - Timeout clears instruction

    func testTimeoutClearsTelegramInstruction() {
        sentMessages.removeAll()
        let shortTimeoutStore = SettingsStore(
            daemonClient: daemonClient,
            guardianChallengeTimeoutDuration: 0.15,
            guardianStatusPollInterval: 0.05,
            guardianStatusPollWindow: 2.0
        )

        shortTimeoutStore.startChannelGuardianVerification(channel: "telegram")

        // Manually set instruction to simulate a previous challenge's stale text
        // that persists when a new challenge times out before the daemon responds.
        shortTimeoutStore.telegramGuardianInstruction = "Send code stale on Telegram"

        // Wait for the timeout to fire
        let predicate = NSPredicate { _, _ in
            shortTimeoutStore.telegramGuardianError != nil
        }
        let timeoutExpectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [timeoutExpectation], timeout: 2.0)

        XCTAssertNil(shortTimeoutStore.telegramGuardianInstruction)
        XCTAssertFalse(shortTimeoutStore.telegramGuardianVerificationInProgress)
    }

    func testTimeoutClearsSmsInstruction() {
        sentMessages.removeAll()
        let shortTimeoutStore = SettingsStore(
            daemonClient: daemonClient,
            guardianChallengeTimeoutDuration: 0.15,
            guardianStatusPollInterval: 0.05,
            guardianStatusPollWindow: 2.0
        )

        shortTimeoutStore.startChannelGuardianVerification(channel: "sms")

        // Manually set instruction to simulate a previous challenge's stale text
        shortTimeoutStore.smsGuardianInstruction = "Send code stale via SMS"

        // Wait for the timeout to fire
        let predicate = NSPredicate { _, _ in
            shortTimeoutStore.smsGuardianError != nil
        }
        let timeoutExpectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [timeoutExpectation], timeout: 2.0)

        XCTAssertNil(shortTimeoutStore.smsGuardianInstruction)
        XCTAssertFalse(shortTimeoutStore.smsGuardianVerificationInProgress)
    }

    // MARK: - Cross-channel timeout isolation

    func testResponseForChannelADoesNotCancelTimeoutForChannelB() {
        // Use a short timeout so the test completes quickly
        sentMessages.removeAll()
        let shortTimeoutStore = SettingsStore(
            daemonClient: daemonClient,
            guardianChallengeTimeoutDuration: 0.3,
            guardianStatusPollInterval: 0.05,
            guardianStatusPollWindow: 2.0
        )

        // Start SMS verification — this arms the timeout for SMS
        shortTimeoutStore.startChannelGuardianVerification(channel: "sms")
        XCTAssertTrue(shortTimeoutStore.smsGuardianVerificationInProgress)

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
        XCTAssertTrue(shortTimeoutStore.smsGuardianVerificationInProgress)
        XCTAssertNil(shortTimeoutStore.smsGuardianError)

        // Wait for the SMS timeout to fire (0.3s + buffer)
        let predicate = NSPredicate { _, _ in !shortTimeoutStore.smsGuardianVerificationInProgress }
        let timeoutExpectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [timeoutExpectation], timeout: 2.0)

        // The SMS timeout should have fired, clearing the spinner and setting an error
        XCTAssertFalse(shortTimeoutStore.smsGuardianVerificationInProgress)
        XCTAssertEqual(shortTimeoutStore.smsGuardianError, "Timed out waiting for verification instructions. Try again.")
    }

    // MARK: - Voice Guardian Verification

    func testStartVoiceVerificationSetsInProgressAndSendsChallenge() {
        store.startChannelGuardianVerification(channel: "voice")

        XCTAssertTrue(store.voiceGuardianVerificationInProgress)
        XCTAssertNil(store.voiceGuardianError)

        let guardianMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let challengeMessages = guardianMessages.filter { $0.action == "create_session" && $0.channel == "voice" }
        XCTAssertEqual(challengeMessages.count, 1)
    }

    func testSuccessfulStatusResponseUpdatesVoiceGuardianState() {
        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: nil,
            instruction: nil,
            bound: true,
            guardianExternalUserId: "+15559876543",
            channel: "voice",
            assistantId: "self",
            guardianDeliveryChatId: nil,
            error: nil
        ))

        let predicate = NSPredicate { _, _ in self.store.voiceGuardianVerified }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.voiceGuardianIdentity, "+15559876543")
        XCTAssertTrue(store.voiceGuardianVerified)
        XCTAssertFalse(store.voiceGuardianVerificationInProgress)
        XCTAssertNil(store.voiceGuardianError)
    }

    func testFailedResponseSetsVoiceError() {
        store.voiceGuardianVerificationInProgress = true

        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: false,
            secret: nil,
            instruction: nil,
            bound: nil,
            guardianExternalUserId: nil,
            channel: "voice",
            assistantId: "self",
            guardianDeliveryChatId: nil,
            error: "Voice channel not configured"
        ))

        let predicate = NSPredicate { _, _ in !self.store.voiceGuardianVerificationInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertFalse(store.voiceGuardianVerificationInProgress)
        XCTAssertEqual(store.voiceGuardianError, "Voice channel not configured")
    }

    func testRevokeVoiceGuardianSendsRevokeAction() {
        store.revokeChannelGuardian(channel: "voice")

        let guardianMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let revokeMessages = guardianMessages.filter { $0.action == "revoke" && $0.channel == "voice" }
        XCTAssertEqual(revokeMessages.count, 1)
    }

    func testRevokeVoiceGuardianClearsInstruction() {
        store.voiceGuardianInstruction = "Call and say 123456"

        store.revokeChannelGuardian(channel: "voice")

        XCTAssertNil(store.voiceGuardianInstruction)
    }

    func testTimeoutClearsVoiceInstruction() {
        sentMessages.removeAll()
        let shortTimeoutStore = SettingsStore(
            daemonClient: daemonClient,
            guardianChallengeTimeoutDuration: 0.15,
            guardianStatusPollInterval: 0.05,
            guardianStatusPollWindow: 2.0
        )

        shortTimeoutStore.startChannelGuardianVerification(channel: "voice")

        shortTimeoutStore.voiceGuardianInstruction = "Call and say 123456"

        let predicate = NSPredicate { _, _ in
            shortTimeoutStore.voiceGuardianError != nil
        }
        let timeoutExpectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [timeoutExpectation], timeout: 2.0)

        XCTAssertNil(shortTimeoutStore.voiceGuardianInstruction)
        XCTAssertFalse(shortTimeoutStore.voiceGuardianVerificationInProgress)
    }

    func testVoiceResponseDoesNotAffectTelegramOrSmsState() {
        daemonClient.onChannelVerificationSessionResponse?(ChannelVerificationSessionResponseMessage(
            type: "channel_verification_session_response",
            success: true,
            secret: nil,
            instruction: nil,
            bound: true,
            guardianExternalUserId: "+15559876543",
            channel: "voice",
            assistantId: "self",
            guardianDeliveryChatId: nil,
            error: nil
        ))

        let predicate = NSPredicate { _, _ in self.store.voiceGuardianVerified }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        // Telegram and SMS should be unaffected
        XCTAssertNil(store.telegramGuardianIdentity)
        XCTAssertFalse(store.telegramGuardianVerified)
        XCTAssertNil(store.smsGuardianIdentity)
        XCTAssertFalse(store.smsGuardianVerified)
    }

    // MARK: - Outbound Verification: startOutboundGuardianVerification

    func testStartOutboundVerificationSendsCorrectIPCMessage() {
        store.startOutboundGuardianVerification(channel: "sms", destination: "+15551234567")

        let guardianMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let outboundMessages = guardianMessages.filter { $0.action == "create_session" && $0.channel == "sms" }
        XCTAssertEqual(outboundMessages.count, 1)
        XCTAssertEqual(outboundMessages.first?.destination, "+15551234567")
        XCTAssertTrue(store.smsGuardianVerificationInProgress)
    }

    func testStartOutboundVerificationClearsExistingOutboundState() {
        store.smsOutboundSessionId = "old-session"
        store.smsOutboundExpiresAt = Date()
        store.smsOutboundSendCount = 3

        store.startOutboundGuardianVerification(channel: "sms", destination: "+15551234567")

        XCTAssertNil(store.smsOutboundSessionId)
        XCTAssertNil(store.smsOutboundExpiresAt)
        XCTAssertEqual(store.smsOutboundSendCount, 0)
    }

    func testStartOutboundTelegramVerificationSendsCorrectMessage() {
        store.startOutboundGuardianVerification(channel: "telegram", destination: "@guardian_user")

        let guardianMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let outboundMessages = guardianMessages.filter { $0.action == "create_session" && $0.channel == "telegram" }
        XCTAssertEqual(outboundMessages.count, 1)
        XCTAssertEqual(outboundMessages.first?.destination, "@guardian_user")
        XCTAssertTrue(store.telegramGuardianVerificationInProgress)
    }

    // MARK: - Outbound Verification: response populates session state

    func testOutboundResponsePopulatesSessionState() {
        store.smsGuardianVerificationInProgress = true

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
        store.telegramGuardianVerificationInProgress = true

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
        let guardianMessagesBefore = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let resendCountBefore = guardianMessagesBefore.filter { $0.action == "resend_session" }.count

        store.resendOutboundGuardian(channel: "sms")

        let guardianMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let resendMessages = guardianMessages.filter { $0.action == "resend_session" && $0.channel == "sms" }
        XCTAssertEqual(resendMessages.count, resendCountBefore + 1)
    }

    // MARK: - Outbound Verification: cancel clears state

    func testCancelOutboundClearsState() {
        store.smsOutboundSessionId = "sess-to-cancel"
        store.smsOutboundExpiresAt = Date().addingTimeInterval(300)
        store.smsOutboundSendCount = 2
        store.smsGuardianVerificationInProgress = true

        store.cancelOutboundGuardian(channel: "sms")

        XCTAssertNil(store.smsOutboundSessionId)
        XCTAssertNil(store.smsOutboundExpiresAt)
        XCTAssertNil(store.smsOutboundNextResendAt)
        XCTAssertEqual(store.smsOutboundSendCount, 0)
        XCTAssertFalse(store.smsGuardianVerificationInProgress)

        let guardianMessages = sentMessages.compactMap { $0 as? ChannelVerificationSessionRequestMessage }
        let cancelMessages = guardianMessages.filter { $0.action == "cancel_session" && $0.channel == "sms" }
        XCTAssertEqual(cancelMessages.count, 1)
    }

    func testCancelOutboundTelegramClearsBootstrapUrl() {
        store.telegramOutboundSessionId = "tg-sess-cancel"
        store.telegramBootstrapUrl = "https://t.me/MyBot?start=verify_abc"

        store.cancelOutboundGuardian(channel: "telegram")

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

        let predicate = NSPredicate { _, _ in self.store.smsGuardianVerified }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertNil(store.smsOutboundSessionId)
        XCTAssertNil(store.smsOutboundExpiresAt)
        XCTAssertEqual(store.smsOutboundSendCount, 0)
        XCTAssertTrue(store.smsGuardianVerified)
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
