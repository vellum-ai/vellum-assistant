import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class SettingsStoreChannelVerificationTests: XCTestCase {

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
        XCTAssertEqual(challengeMessages.first?.assistantId, "self")
    }

    // MARK: - startChannelGuardianVerification (SMS)

    func testStartSmsVerificationSetsInProgressAndSendsChallenge() {
        store.startChannelGuardianVerification(channel: "sms")

        XCTAssertTrue(store.smsGuardianVerificationInProgress)
        XCTAssertNil(store.smsGuardianError)

        let guardianMessages = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
        let challengeMessages = guardianMessages.filter { $0.action == "create_challenge" && $0.channel == "sms" }
        XCTAssertEqual(challengeMessages.count, 1)
        XCTAssertEqual(challengeMessages.first?.assistantId, "self")
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

    func testResponseWithNilChannelIsIgnored() {
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

    // MARK: - revokeChannelGuardian

    func testRevokeChannelGuardianSendsRevokeAction() {
        let guardianMessagesBefore = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
        let revokeCountBefore = guardianMessagesBefore.filter { $0.action == "revoke" }.count
        XCTAssertEqual(revokeCountBefore, 0)

        store.revokeChannelGuardian(channel: "telegram")

        let guardianMessages = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
        let revokeMessages = guardianMessages.filter { $0.action == "revoke" && $0.channel == "telegram" }
        XCTAssertEqual(revokeMessages.count, 1)
        XCTAssertEqual(revokeMessages.first?.assistantId, "self")
    }

    func testRevokeSmsGuardianSendsRevokeAction() {
        store.revokeChannelGuardian(channel: "sms")

        let guardianMessages = sentMessages.compactMap { $0 as? GuardianVerificationRequestMessage }
        let revokeMessages = guardianMessages.filter { $0.action == "revoke" && $0.channel == "sms" }
        XCTAssertEqual(revokeMessages.count, 1)
        XCTAssertEqual(revokeMessages.first?.assistantId, "self")
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
    }
}
