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
    }

    // MARK: - refreshChannelGuardianStatus

    func testRefreshChannelGuardianStatusSendsStatusRequest() {
        // Init already sends status requests, count those first
        let guardianMessagesBefore = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
        let statusCountBefore = guardianMessagesBefore.filter { $0.action == "status" }.count

        store.refreshChannelGuardianStatus(channel: "telegram")

        let guardianMessages = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
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

        let guardianMessages = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
        let challengeMessages = guardianMessages.filter { $0.action == "create_challenge" && $0.channel == "telegram" }
        XCTAssertEqual(challengeMessages.count, 1)
        XCTAssertEqual(challengeMessages.first?.assistantId, testAssistantId)
    }

    // MARK: - startChannelGuardianVerification (SMS)

    func testStartSmsVerificationSetsInProgressAndSendsChallenge() {
        store.startChannelGuardianVerification(channel: "sms")

        XCTAssertTrue(store.smsGuardianVerificationInProgress)
        XCTAssertNil(store.smsGuardianError)

        let guardianMessages = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
        let challengeMessages = guardianMessages.filter { $0.action == "create_challenge" && $0.channel == "sms" }
        XCTAssertEqual(challengeMessages.count, 1)
        XCTAssertEqual(challengeMessages.first?.assistantId, testAssistantId)
    }

    // MARK: - Successful status response

    func testSuccessfulStatusResponseUpdatesTelegramGuardianState() {
        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
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
        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
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

    // MARK: - Successful create_challenge response provides instruction

    func testSuccessfulChallengeResponseProvidesInstruction() {
        store.telegramGuardianVerificationInProgress = true

        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
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
        store.telegramGuardianInstruction = "Send /guardian_verify abc123 on Telegram"

        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
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

        XCTAssertEqual(store.telegramGuardianInstruction, "Send /guardian_verify abc123 on Telegram")
        XCTAssertFalse(store.telegramGuardianVerified)
    }

    func testVerifiedStatusResponseClearsExistingTelegramInstruction() {
        store.telegramGuardianInstruction = "Send /guardian_verify abc123 on Telegram"

        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
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

        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
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

        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
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
        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
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
        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
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

        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
            success: true,
            secret: "abc123",
            instruction: "Send /guardian_verify abc123 on Telegram",
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

        XCTAssertEqual(store.telegramGuardianInstruction, "Send /guardian_verify abc123 on Telegram")
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

        let statusCountBefore = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
            .filter { $0.action == "status" && $0.channel == "telegram" }
            .count

        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
            success: true,
            secret: "poll-me",
            instruction: "Send /guardian_verify poll-me on Telegram",
            bound: false,
            guardianExternalUserId: nil,
            channel: "telegram",
            assistantId: testAssistantId,
            guardianDeliveryChatId: nil,
            error: nil
        ))

        let predicate = NSPredicate { _, _ in
            let statusCountAfter = self.sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
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

        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
            success: true,
            secret: "poll-me",
            instruction: "Send /guardian_verify poll-me on Telegram",
            bound: false,
            guardianExternalUserId: nil,
            channel: "telegram",
            assistantId: testAssistantId,
            guardianDeliveryChatId: nil,
            error: nil
        ))

        let pollingStartedPredicate = NSPredicate { _, _ in
            let statusCount = self.sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
                .filter { $0.action == "status" && $0.channel == "telegram" }
                .count
            return statusCount > 1
        }
        let pollingStartedExpectation = XCTNSPredicateExpectation(predicate: pollingStartedPredicate, object: nil)
        wait(for: [pollingStartedExpectation], timeout: 2.0)

        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
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

        let statusCountAfterVerification = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
            .filter { $0.action == "status" && $0.channel == "telegram" }
            .count

        let settleTwo = expectation(description: "settleTwo")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { settleTwo.fulfill() }
        wait(for: [settleTwo], timeout: 1.0)

        let statusCountFinal = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
            .filter { $0.action == "status" && $0.channel == "telegram" }
            .count

        XCTAssertEqual(statusCountFinal, statusCountAfterVerification)
    }

    // MARK: - revokeChannelGuardian

    func testRevokeChannelGuardianSendsRevokeAction() {
        let guardianMessagesBefore = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
        let revokeCountBefore = guardianMessagesBefore.filter { $0.action == "revoke" }.count
        XCTAssertEqual(revokeCountBefore, 0)

        store.revokeChannelGuardian(channel: "telegram")

        let guardianMessages = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
        let revokeMessages = guardianMessages.filter { $0.action == "revoke" && $0.channel == "telegram" }
        XCTAssertEqual(revokeMessages.count, 1)
        XCTAssertEqual(revokeMessages.first?.assistantId, testAssistantId)
    }

    func testRevokeSmsGuardianSendsRevokeAction() {
        store.revokeChannelGuardian(channel: "sms")

        let guardianMessages = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
        let revokeMessages = guardianMessages.filter { $0.action == "revoke" && $0.channel == "sms" }
        XCTAssertEqual(revokeMessages.count, 1)
        XCTAssertEqual(revokeMessages.first?.assistantId, testAssistantId)
    }

    // MARK: - No daemon client doesn't crash

    func testNoDaemonClientDoesNotCrash() {
        let orphanStore = SettingsStore()

        // None of these should crash
        orphanStore.refreshChannelGuardianStatus(channel: "telegram")
        orphanStore.refreshChannelGuardianStatus(channel: "sms")
        orphanStore.startChannelGuardianVerification(channel: "telegram")
        orphanStore.startChannelGuardianVerification(channel: "sms")
        orphanStore.revokeChannelGuardian(channel: "telegram")
        orphanStore.revokeChannelGuardian(channel: "sms")
    }

    // MARK: - Successful response clears previous error

    func testSuccessfulResponseClearsPreviousError() {
        store.telegramGuardianError = "old error"

        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
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
        let messageCountBefore = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
            .filter { $0.action == "create_challenge" }.count

        store.startChannelGuardianVerification(channel: "discord")

        let messageCountAfter = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
            .filter { $0.action == "create_challenge" }.count
        XCTAssertEqual(messageCountAfter, messageCountBefore)
    }

    // MARK: - Init sends status requests for both channels

    func testInitSendsGuardianStatusRequestsForBothChannels() {
        let guardianMessages = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
        let statusMessages = guardianMessages.filter { $0.action == "status" }

        let telegramStatus = statusMessages.filter { $0.channel == "telegram" }
        let smsStatus = statusMessages.filter { $0.channel == "sms" }

        XCTAssertEqual(telegramStatus.count, 1)
        XCTAssertEqual(smsStatus.count, 1)
        XCTAssertEqual(telegramStatus.first?.assistantId, testAssistantId)
        XCTAssertEqual(smsStatus.first?.assistantId, testAssistantId)
    }

    func testStatusPollResponseDoesNotClearGuardianChallengePending() {
        store.startChannelGuardianVerification(channel: "telegram")
        XCTAssertTrue(store.telegramGuardianVerificationInProgress)

        // Simulate a status poll response (no secret, no instruction, not bound)
        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
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
        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
            success: true,
            secret: "abc123",
            instruction: "Send /guardian_verify abc123 on Telegram",
            bound: false,
            guardianExternalUserId: nil,
            channel: "telegram",
            assistantId: testAssistantId,
            guardianDeliveryChatId: nil,
            error: nil
        ))

        XCTAssertEqual(store.telegramGuardianInstruction, "Send /guardian_verify abc123 on Telegram")
        XCTAssertFalse(store.telegramGuardianVerificationInProgress)
    }

    func testGuardianRequestsFallBackToSelfWhenNoConnectedAssistantId() {
        UserDefaults.standard.removeObject(forKey: connectedAssistantIdDefaultsKey)
        sentMessages.removeAll()

        let localStore = SettingsStore(daemonClient: daemonClient)
        localStore.startChannelGuardianVerification(channel: "telegram")
        localStore.revokeChannelGuardian(channel: "sms")

        let guardianMessages = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
        let statusMessages = guardianMessages.filter { $0.action == "status" }
        let createMessages = guardianMessages.filter { $0.action == "create_challenge" }
        let revokeMessages = guardianMessages.filter { $0.action == "revoke" }

        XCTAssertTrue(statusMessages.allSatisfy { $0.assistantId == "self" })
        XCTAssertTrue(createMessages.allSatisfy { $0.assistantId == "self" })
        XCTAssertTrue(revokeMessages.allSatisfy { $0.assistantId == "self" })
    }

    // MARK: - Revoke clears instruction

    func testRevokeTelegramGuardianClearsInstruction() {
        store.telegramGuardianInstruction = "Send /guardian_verify abc123 on Telegram"

        store.revokeChannelGuardian(channel: "telegram")

        XCTAssertNil(store.telegramGuardianInstruction)
    }

    func testRevokeSmsGuardianClearsInstruction() {
        store.smsGuardianInstruction = "Send /guardian_verify abc123 via SMS"

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
        shortTimeoutStore.telegramGuardianInstruction = "Send /guardian_verify stale on Telegram"

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
        shortTimeoutStore.smsGuardianInstruction = "Send /guardian_verify stale via SMS"

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
        daemonClient.onGuardianVerificationResponse?(GuardianVerificationResponseMessage(
            type: "guardian_verification_response",
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
}
