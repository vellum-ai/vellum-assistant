import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class SettingsStoreChannelVerificationTests: XCTestCase {

    private var connectionManager: GatewayConnectionManager!
    private var mockSettingsClient: MockSettingsClient!
    private var store: SettingsStore!
    private let connectedAssistantIdDefaultsKey = "connectedAssistantId"
    private let testAssistantId = "ast-settings-tests"
    private var previousConnectedAssistantId: String?

    override func setUp() {
        super.setUp()
        previousConnectedAssistantId = UserDefaults.standard.string(forKey: connectedAssistantIdDefaultsKey)
        UserDefaults.standard.set(testAssistantId, forKey: connectedAssistantIdDefaultsKey)
        connectionManager = GatewayConnectionManager()
        connectionManager.isConnected = true
        mockSettingsClient = MockSettingsClient()
        store = SettingsStore(connectionManager: connectionManager, settingsClient: mockSettingsClient)
    }

    override func tearDown() {
        store = nil
        connectionManager = nil
        mockSettingsClient = nil
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

        XCTAssertNil(store.voiceVerificationIdentity)
        XCTAssertFalse(store.voiceVerificationVerified)
        XCTAssertFalse(store.voiceVerificationInProgress)
        XCTAssertNil(store.voiceVerificationInstruction)
        XCTAssertNil(store.voiceVerificationError)
    }

    // MARK: - refreshChannelVerificationStatus

    func testRefreshChannelVerificationStatusCallsSettingsClient() {
        let callCountBefore = mockSettingsClient.fetchChannelVerificationStatusCalls.count

        store.refreshChannelVerificationStatus(channel: "telegram")

        let predicate = NSPredicate { _, _ in
            self.mockSettingsClient.fetchChannelVerificationStatusCalls.count > callCountBefore
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        let newCalls = Array(mockSettingsClient.fetchChannelVerificationStatusCalls.dropFirst(callCountBefore))
        XCTAssertEqual(newCalls, ["telegram"])
    }

    // MARK: - startChannelVerification (Telegram)

    func testStartTelegramVerificationSetsInProgressAndSendsSession() {
        store.startChannelVerification(channel: "telegram")

        XCTAssertTrue(store.telegramVerificationInProgress)
        XCTAssertNil(store.telegramVerificationError)

        let predicate = NSPredicate { _, _ in
            self.mockSettingsClient.sendChannelVerificationSessionCalls.contains { $0.action == "create_session" && $0.channel == "telegram" }
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        let sessionCalls = mockSettingsClient.sendChannelVerificationSessionCalls.filter { $0.action == "create_session" && $0.channel == "telegram" }
        XCTAssertEqual(sessionCalls.count, 1)
    }

    // MARK: - Successful status response

    func testSuccessfulStatusResponseUpdatesTelegramVerificationState() {
        store.applyChannelVerificationResponse(ChannelVerificationSessionResponseMessage(
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

    // MARK: - Successful create_session response provides instruction

    func testSuccessfulSessionResponseProvidesInstruction() {
        store.telegramVerificationInProgress = true

        store.applyChannelVerificationResponse(ChannelVerificationSessionResponseMessage(
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

        store.applyChannelVerificationResponse(ChannelVerificationSessionResponseMessage(
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

        store.applyChannelVerificationResponse(ChannelVerificationSessionResponseMessage(
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

        store.applyChannelVerificationResponse(ChannelVerificationSessionResponseMessage(
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

    // MARK: - Unknown channel is silently ignored

    func testResponseForUnknownChannelIsIgnored() {
        store.applyChannelVerificationResponse(ChannelVerificationSessionResponseMessage(
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

        // Neither telegram nor voice state should change
        XCTAssertNil(store.telegramVerificationIdentity)
        XCTAssertFalse(store.telegramVerificationVerified)
    }

    func testResponseWithNilChannelAndNoPendingStateIsIgnored() {
        store.applyChannelVerificationResponse(ChannelVerificationSessionResponseMessage(
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
    }

    func testResponseWithNilChannelUsesPendingVerificationChannel() {
        mockSettingsClient.sendChannelVerificationSessionResponse = ChannelVerificationSessionResponseMessage(
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
        )

        store.startChannelVerification(channel: "telegram")
        XCTAssertTrue(store.telegramVerificationInProgress)

        let predicate = NSPredicate { _, _ in !self.store.telegramVerificationInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.telegramVerificationInstruction, "Send code abc123 on Telegram")
        XCTAssertFalse(store.telegramVerificationInProgress)
        XCTAssertNil(store.telegramVerificationError)
    }

    func testSessionResponseStartsVerificationStatusPolling() {
        let pollingMock = MockSettingsClient()
        pollingMock.sendChannelVerificationSessionResponse = ChannelVerificationSessionResponseMessage(
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
        )
        let pollingStore = SettingsStore(
            connectionManager: connectionManager,
            settingsClient: pollingMock,
            verificationStatusPollInterval: 0.05,
            verificationStatusPollWindow: 2.0
        )

        let statusCountBefore = pollingMock.fetchChannelVerificationStatusCalls
            .filter { $0 == "telegram" }.count

        pollingStore.startChannelVerification(channel: "telegram")

        let predicate = NSPredicate { _, _ in
            let statusCountAfter = pollingMock.fetchChannelVerificationStatusCalls
                .filter { $0 == "telegram" }.count
            return statusCountAfter > statusCountBefore
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)
    }

    func testVerifiedResponseStopsVerificationStatusPolling() {
        let pollingMock = MockSettingsClient()
        pollingMock.sendChannelVerificationSessionResponse = ChannelVerificationSessionResponseMessage(
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
        )
        let pollingStore = SettingsStore(
            connectionManager: connectionManager,
            settingsClient: pollingMock,
            verificationStatusPollInterval: 0.05,
            verificationStatusPollWindow: 2.0
        )
        pollingStore.startChannelVerification(channel: "telegram")

        let pollingStartedPredicate = NSPredicate { _, _ in
            let statusCount = pollingMock.fetchChannelVerificationStatusCalls
                .filter { $0 == "telegram" }.count
            return statusCount > 1
        }
        let pollingStartedExpectation = XCTNSPredicateExpectation(predicate: pollingStartedPredicate, object: nil)
        wait(for: [pollingStartedExpectation], timeout: 2.0)

        pollingStore.applyChannelVerificationResponse(ChannelVerificationSessionResponseMessage(
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

        let statusCountAfterVerification = pollingMock.fetchChannelVerificationStatusCalls
            .filter { $0 == "telegram" }.count

        let settleTwo = expectation(description: "settleTwo")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { settleTwo.fulfill() }
        wait(for: [settleTwo], timeout: 1.0)

        let statusCountFinal = pollingMock.fetchChannelVerificationStatusCalls
            .filter { $0 == "telegram" }.count

        XCTAssertEqual(statusCountFinal, statusCountAfterVerification)
    }

    // MARK: - revokeChannelVerification

    func testRevokeChannelVerificationSendsRevokeAction() {
        store.revokeChannelVerification(channel: "telegram")

        let predicate = NSPredicate { _, _ in
            self.mockSettingsClient.sendChannelVerificationSessionCalls.contains { $0.action == "revoke" && $0.channel == "telegram" }
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        let revokeCalls = mockSettingsClient.sendChannelVerificationSessionCalls.filter { $0.action == "revoke" && $0.channel == "telegram" }
        XCTAssertEqual(revokeCalls.count, 1)
    }

    // MARK: - No daemon client doesn't crash

    func testNoGatewayConnectionManagerDoesNotCrash() {
        let orphanStore = SettingsStore()

        // None of these should crash
        orphanStore.refreshChannelVerificationStatus(channel: "telegram")
        orphanStore.refreshChannelVerificationStatus(channel: "phone")
        orphanStore.startChannelVerification(channel: "telegram")
        orphanStore.startChannelVerification(channel: "phone")
        orphanStore.revokeChannelVerification(channel: "telegram")
        orphanStore.revokeChannelVerification(channel: "phone")
    }

    // MARK: - Successful response clears previous error

    func testSuccessfulResponseClearsPreviousError() {
        store.telegramVerificationError = "old error"

        store.applyChannelVerificationResponse(ChannelVerificationSessionResponseMessage(
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
        let callCountBefore = mockSettingsClient.sendChannelVerificationSessionCalls.count

        store.startChannelVerification(channel: "discord")

        // Give a brief window for any async task to fire (it shouldn't)
        let settle = expectation(description: "settle")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { settle.fulfill() }
        wait(for: [settle], timeout: 1.0)

        let callCountAfter = mockSettingsClient.sendChannelVerificationSessionCalls.count
        XCTAssertEqual(callCountAfter, callCountBefore)
    }

    // MARK: - Init sends status requests for all channels

    func testInitSendsVerificationStatusRequestsForAllChannels() {
        let predicate = NSPredicate { _, _ in
            self.mockSettingsClient.fetchChannelVerificationStatusCalls.count >= 3
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        let calls = mockSettingsClient.fetchChannelVerificationStatusCalls
        XCTAssertTrue(calls.contains("telegram"))
        XCTAssertTrue(calls.contains("phone"))
        XCTAssertTrue(calls.contains("slack"))
    }

    func testStatusPollResponseDoesNotClearVerificationSessionPending() {
        mockSettingsClient.sendChannelVerificationSessionResponse = ChannelVerificationSessionResponseMessage(
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
        )

        store.startChannelVerification(channel: "telegram")
        XCTAssertTrue(store.telegramVerificationInProgress)

        let predicate = NSPredicate { _, _ in !self.store.telegramVerificationInProgress }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.telegramVerificationInstruction, "Send code abc123 on Telegram")
        XCTAssertFalse(store.telegramVerificationInProgress)
    }

    // MARK: - Revoke clears instruction

    func testRevokeTelegramVerificationClearsInstruction() {
        store.telegramVerificationInstruction = "Send code abc123 on Telegram"

        store.revokeChannelVerification(channel: "telegram")

        XCTAssertNil(store.telegramVerificationInstruction)
    }

    // MARK: - Timeout clears instruction

    func testTimeoutClearsTelegramInstruction() {
        let shortTimeoutStore = SettingsStore(
            connectionManager: connectionManager,
            settingsClient: mockSettingsClient,
            verificationSessionTimeoutDuration: 0.15,
            verificationStatusPollInterval: 0.05,
            verificationStatusPollWindow: 2.0
        )

        shortTimeoutStore.startChannelVerification(channel: "telegram")

        // Manually set instruction to simulate a previous session's stale text
        // that persists when a new session times out before the server responds.
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

    // MARK: - Cross-channel timeout isolation

    func testResponseForChannelADoesNotCancelTimeoutForChannelB() {
        // Use a short timeout so the test completes quickly
        let shortTimeoutStore = SettingsStore(
            connectionManager: connectionManager,
            settingsClient: mockSettingsClient,
            verificationSessionTimeoutDuration: 0.3,
            verificationStatusPollInterval: 0.05,
            verificationStatusPollWindow: 2.0
        )

        // Start voice verification — this arms the timeout for voice
        shortTimeoutStore.startChannelVerification(channel: "phone")
        XCTAssertTrue(shortTimeoutStore.voiceVerificationInProgress)

        // A telegram response arrives — this must NOT cancel the voice timeout
        store.applyChannelVerificationResponse(ChannelVerificationSessionResponseMessage(
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

        // Voice should still be in progress right after the telegram response
        XCTAssertTrue(shortTimeoutStore.voiceVerificationInProgress)
        XCTAssertNil(shortTimeoutStore.voiceVerificationError)

        // Wait for the voice timeout to fire (0.3s + buffer)
        let predicate = NSPredicate { _, _ in !shortTimeoutStore.voiceVerificationInProgress }
        let timeoutExpectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [timeoutExpectation], timeout: 2.0)

        // The voice timeout should have fired, clearing the spinner and setting an error
        XCTAssertFalse(shortTimeoutStore.voiceVerificationInProgress)
        XCTAssertEqual(shortTimeoutStore.voiceVerificationError, "Timed out waiting for verification instructions. Try again.")
    }

    // MARK: - Voice Channel Verification

    func testStartVoiceVerificationSetsInProgressAndSendsSession() {
        store.startChannelVerification(channel: "phone")

        XCTAssertTrue(store.voiceVerificationInProgress)
        XCTAssertNil(store.voiceVerificationError)

        let predicate = NSPredicate { _, _ in
            self.mockSettingsClient.sendChannelVerificationSessionCalls.contains { $0.action == "create_session" && $0.channel == "phone" }
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        let sessionCalls = mockSettingsClient.sendChannelVerificationSessionCalls.filter { $0.action == "create_session" && $0.channel == "phone" }
        XCTAssertEqual(sessionCalls.count, 1)
    }

    func testSuccessfulStatusResponseUpdatesVoiceVerificationState() {
        store.applyChannelVerificationResponse(ChannelVerificationSessionResponseMessage(
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

        store.applyChannelVerificationResponse(ChannelVerificationSessionResponseMessage(
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

        let predicate = NSPredicate { _, _ in
            self.mockSettingsClient.sendChannelVerificationSessionCalls.contains { $0.action == "revoke" && $0.channel == "phone" }
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        let revokeCalls = mockSettingsClient.sendChannelVerificationSessionCalls.filter { $0.action == "revoke" && $0.channel == "phone" }
        XCTAssertEqual(revokeCalls.count, 1)
    }

    func testRevokeVoiceVerificationClearsInstruction() {
        store.voiceVerificationInstruction = "Call and say 123456"

        store.revokeChannelVerification(channel: "phone")

        XCTAssertNil(store.voiceVerificationInstruction)
    }

    func testTimeoutClearsVoiceInstruction() {
        let shortTimeoutStore = SettingsStore(
            connectionManager: connectionManager,
            settingsClient: mockSettingsClient,
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

    func testVoiceResponseDoesNotAffectTelegramState() {
        store.applyChannelVerificationResponse(ChannelVerificationSessionResponseMessage(
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

        // Telegram should be unaffected
        XCTAssertNil(store.telegramVerificationIdentity)
        XCTAssertFalse(store.telegramVerificationVerified)
    }

    // MARK: - Outbound Verification: startOutboundVerification

    func testStartOutboundTelegramVerificationSendsCorrectMessage() {
        store.startOutboundVerification(channel: "telegram", destination: "@guardian_user")

        let predicate = NSPredicate { _, _ in
            self.mockSettingsClient.sendChannelVerificationSessionCalls.contains { $0.action == "create_session" && $0.channel == "telegram" }
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        let outboundCalls = mockSettingsClient.sendChannelVerificationSessionCalls.filter { $0.action == "create_session" && $0.channel == "telegram" }
        XCTAssertEqual(outboundCalls.count, 1)
        XCTAssertEqual(outboundCalls.first?.destination, "@guardian_user")
        XCTAssertTrue(store.telegramVerificationInProgress)
    }

    // MARK: - Outbound Verification: Telegram bootstrap URL

    func testTelegramBootstrapUrlIsStored() {
        store.telegramVerificationInProgress = true

        let expiresMs = Int(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)

        store.applyChannelVerificationResponse(ChannelVerificationSessionResponseMessage(
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

    // MARK: - Outbound Verification: cancel clears state


    func testCancelOutboundTelegramClearsBootstrapUrl() {
        store.telegramOutboundSessionId = "tg-sess-cancel"
        store.telegramBootstrapUrl = "https://t.me/MyBot?start=verify_abc"

        store.cancelOutboundVerification(channel: "telegram")

        XCTAssertNil(store.telegramOutboundSessionId)
        XCTAssertNil(store.telegramBootstrapUrl)
    }

    // MARK: - Outbound Verification: initial state is nil

    func testInitialOutboundStateIsNilOrZero() {
        XCTAssertNil(store.telegramOutboundSessionId)
        XCTAssertNil(store.telegramOutboundExpiresAt)
        XCTAssertNil(store.telegramOutboundNextResendAt)
        XCTAssertEqual(store.telegramOutboundSendCount, 0)
        XCTAssertNil(store.telegramBootstrapUrl)

        XCTAssertNil(store.voiceOutboundSessionId)
        XCTAssertNil(store.voiceOutboundExpiresAt)
        XCTAssertNil(store.voiceOutboundNextResendAt)
        XCTAssertEqual(store.voiceOutboundSendCount, 0)
    }
}
