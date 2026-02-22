import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ToolPermissionTesterModelTests: XCTestCase {

    private var daemonClient: DaemonClient!
    private var sentMessages: [Any] = []
    private var model: ToolPermissionTesterModel!

    override func setUp() {
        super.setUp()
        sentMessages = []
        daemonClient = DaemonClient()
        daemonClient.isConnected = true
        daemonClient.sendOverride = { [weak self] message in
            self?.sentMessages.append(message)
        }
        model = ToolPermissionTesterModel(daemonClient: daemonClient)
    }

    override func tearDown() {
        model = nil
        daemonClient = nil
        sentMessages = []
        super.tearDown()
    }

    // MARK: - parseInputJSON

    func testParseInputJSON_validJSON() throws {
        let result = try model.parseInputJSON("""
        {"command": "ls -la", "timeout": 5000}
        """)
        XCTAssertEqual(result.count, 2)
    }

    func testParseInputJSON_emptyString() throws {
        let result = try model.parseInputJSON("")
        XCTAssertTrue(result.isEmpty)
    }

    func testParseInputJSON_whitespaceOnly() throws {
        let result = try model.parseInputJSON("   \n  ")
        XCTAssertTrue(result.isEmpty)
    }

    func testParseInputJSON_invalidJSON() {
        XCTAssertThrowsError(try model.parseInputJSON("not json"))
    }

    func testParseInputJSON_emptyObject() throws {
        let result = try model.parseInputJSON("{}")
        XCTAssertTrue(result.isEmpty)
    }

    // MARK: - simulate()

    func testSimulate_setsIsSimulating() {
        model.toolName = "host_bash"
        model.inputJSON = "{}"
        model.simulate()

        XCTAssertTrue(model.isSimulating)
    }

    func testSimulate_clearsLastErrorAndResult() {
        model.lastError = "previous error"
        model.lastResult = SimulationResult(
            decision: "allow", riskLevel: "low", reason: "test",
            matchedRuleId: nil, promptPayload: nil
        )

        model.toolName = "host_bash"
        model.inputJSON = "{}"
        model.simulate()

        XCTAssertNil(model.lastError)
        XCTAssertNil(model.lastResult)
    }

    func testSimulate_sendsMessage() {
        model.toolName = "host_bash"
        model.inputJSON = "{\"command\": \"echo hello\"}"
        model.workingDir = "/tmp"
        model.isInteractive = false
        model.forcePromptSideEffects = true
        model.executionTarget = "host"
        model.principalKind = "skill"
        model.principalId = "my-skill"
        model.principalVersion = "abc123"

        model.simulate()

        XCTAssertEqual(sentMessages.count, 1)
        let msg = sentMessages[0] as? ToolPermissionSimulateMessage
        XCTAssertNotNil(msg)
        XCTAssertEqual(msg?.toolName, "host_bash")
        XCTAssertEqual(msg?.workingDir, "/tmp")
        XCTAssertEqual(msg?.isInteractive, false)
        XCTAssertEqual(msg?.forcePromptSideEffects, true)
        XCTAssertEqual(msg?.executionTarget, "host")
        XCTAssertEqual(msg?.principalKind, "skill")
        XCTAssertEqual(msg?.principalId, "my-skill")
        XCTAssertEqual(msg?.principalVersion, "abc123")
    }

    func testSimulate_emptyOptionalFieldsSendNil() {
        model.toolName = "host_bash"
        model.inputJSON = "{}"
        model.workingDir = ""
        model.executionTarget = ""
        model.principalKind = ""

        model.simulate()

        XCTAssertEqual(sentMessages.count, 1)
        let msg = sentMessages[0] as? ToolPermissionSimulateMessage
        XCTAssertNotNil(msg)
        XCTAssertNil(msg?.workingDir)
        XCTAssertNil(msg?.executionTarget)
        XCTAssertNil(msg?.principalKind)
        XCTAssertNil(msg?.principalId)
        XCTAssertNil(msg?.principalVersion)
    }

    func testSimulate_invalidJSON_setsError() {
        model.toolName = "host_bash"
        model.inputJSON = "not json"

        model.simulate()

        XCTAssertNotNil(model.lastError)
        XCTAssertTrue(model.lastError?.starts(with: "Invalid JSON:") == true)
        XCTAssertFalse(model.isSimulating)
    }

    func testSimulate_sendFailure_setsError() {
        daemonClient.sendOverride = { _ in
            throw NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "socket closed"])
        }

        model.toolName = "host_bash"
        model.inputJSON = "{}"
        model.simulate()

        XCTAssertNotNil(model.lastError)
        XCTAssertTrue(model.lastError?.contains("socket closed") == true)
        XCTAssertFalse(model.isSimulating)
    }

    func testSimulate_handlesSuccessResponse() {
        model.toolName = "host_bash"
        model.inputJSON = "{}"
        model.simulate()

        // Simulate the daemon sending a response
        daemonClient.onToolPermissionSimulateResponse?(ToolPermissionSimulateResponseMessage(
            type: "tool_permission_simulate_response",
            success: true,
            decision: "allow",
            riskLevel: "low",
            reason: "Matched trust rule",
            promptPayload: nil,
            matchedRuleId: "rule-42",
            error: nil
        ))

        // Give the Task { @MainActor } a chance to run
        let expectation = XCTestExpectation(description: "Response handled")
        Task { @MainActor in
            // Yield once to let the inner Task run
            try? await Task.sleep(nanoseconds: 10_000_000)
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1.0)

        XCTAssertFalse(model.isSimulating)
        XCTAssertNotNil(model.lastResult)
        XCTAssertEqual(model.lastResult?.decision, "allow")
        XCTAssertEqual(model.lastResult?.riskLevel, "low")
        XCTAssertEqual(model.lastResult?.reason, "Matched trust rule")
        XCTAssertEqual(model.lastResult?.matchedRuleId, "rule-42")
    }

    func testSimulate_handlesErrorResponse() {
        model.toolName = "host_bash"
        model.inputJSON = "{}"
        model.simulate()

        daemonClient.onToolPermissionSimulateResponse?(ToolPermissionSimulateResponseMessage(
            type: "tool_permission_simulate_response",
            success: false,
            decision: nil,
            riskLevel: nil,
            reason: nil,
            promptPayload: nil,
            matchedRuleId: nil,
            error: "Tool not found"
        ))

        let expectation = XCTestExpectation(description: "Response handled")
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 10_000_000)
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1.0)

        XCTAssertFalse(model.isSimulating)
        XCTAssertEqual(model.lastError, "Tool not found")
        XCTAssertNil(model.lastResult)
    }

    // MARK: - allowOnce()

    func testAllowOnce_setsLocalOverrideLabel() {
        model.lastResult = SimulationResult(
            decision: "prompt", riskLevel: "medium", reason: "test",
            matchedRuleId: nil, promptPayload: nil
        )

        model.allowOnce()

        XCTAssertEqual(model.lastResult?.localOverrideLabel, "Allowed (simulation)")
    }

    func testAllowOnce_noResult_doesNothing() {
        model.allowOnce()
        XCTAssertNil(model.lastResult)
    }

    // MARK: - denyOnce()

    func testDenyOnce_setsLocalOverrideLabel() {
        model.lastResult = SimulationResult(
            decision: "prompt", riskLevel: "medium", reason: "test",
            matchedRuleId: nil, promptPayload: nil
        )

        model.denyOnce()

        XCTAssertEqual(model.lastResult?.localOverrideLabel, "Denied (simulation)")
    }

    func testDenyOnce_noResult_doesNothing() {
        model.denyOnce()
        XCTAssertNil(model.lastResult)
    }

    // MARK: - alwaysAllow()

    func testAlwaysAllow_sendsAddTrustRuleAndResimulates() {
        model.toolName = "host_bash"
        model.inputJSON = "{}"
        model.executionTarget = "host"
        model.principalKind = "skill"
        model.principalId = "my-skill"
        model.principalVersion = "v1"
        model.lastResult = SimulationResult(
            decision: "prompt", riskLevel: "medium", reason: "test",
            matchedRuleId: nil, promptPayload: nil
        )

        model.alwaysAllow(pattern: "echo *", scope: "project", decision: "always_allow")

        // Should have sent AddTrustRuleMessage + ToolPermissionSimulateMessage (re-simulate)
        XCTAssertEqual(sentMessages.count, 2)

        let trustRuleMsg = sentMessages[0] as? AddTrustRuleMessage
        XCTAssertNotNil(trustRuleMsg)
        XCTAssertEqual(trustRuleMsg?.toolName, "host_bash")
        XCTAssertEqual(trustRuleMsg?.pattern, "echo *")
        XCTAssertEqual(trustRuleMsg?.scope, "project")
        XCTAssertEqual(trustRuleMsg?.decision, "allow")
        XCTAssertEqual(trustRuleMsg?.executionTarget, "host")
        XCTAssertEqual(trustRuleMsg?.principalKind, "skill")
        XCTAssertEqual(trustRuleMsg?.principalId, "my-skill")
        XCTAssertEqual(trustRuleMsg?.principalVersion, "v1")

        // Second message is the re-simulate
        let resimMsg = sentMessages[1] as? ToolPermissionSimulateMessage
        XCTAssertNotNil(resimMsg)
    }

    func testAlwaysAllow_highRisk_usesAlwaysAllowHighRiskDecision() {
        model.toolName = "host_bash"
        model.inputJSON = "{}"
        model.lastResult = SimulationResult(
            decision: "prompt", riskLevel: "high", reason: "dangerous",
            matchedRuleId: nil, promptPayload: nil
        )

        model.alwaysAllow(pattern: "rm -rf *", scope: "global", decision: "always_allow")

        let trustRuleMsg = sentMessages[0] as? AddTrustRuleMessage
        XCTAssertNotNil(trustRuleMsg)
        XCTAssertEqual(trustRuleMsg?.decision, "allow")
        XCTAssertEqual(trustRuleMsg?.allowHighRisk, true)
    }

    func testAlwaysAllow_mediumRisk_doesNotSetAllowHighRisk() {
        model.toolName = "host_bash"
        model.inputJSON = "{}"
        model.lastResult = SimulationResult(
            decision: "prompt", riskLevel: "medium", reason: "test",
            matchedRuleId: nil, promptPayload: nil
        )

        model.alwaysAllow(pattern: "echo *", scope: "project", decision: "always_allow")

        let trustRuleMsg = sentMessages[0] as? AddTrustRuleMessage
        XCTAssertNotNil(trustRuleMsg)
        XCTAssertEqual(trustRuleMsg?.decision, "allow")
        XCTAssertNil(trustRuleMsg?.allowHighRisk)
    }

    func testAlwaysAllow_emptyMetadata_doesNotPassNilFields() {
        model.toolName = "host_bash"
        model.inputJSON = "{}"
        model.executionTarget = ""
        model.principalKind = ""
        model.lastResult = SimulationResult(
            decision: "prompt", riskLevel: "low", reason: "test",
            matchedRuleId: nil, promptPayload: nil
        )

        model.alwaysAllow(pattern: "*", scope: "global", decision: "always_allow")

        let trustRuleMsg = sentMessages[0] as? AddTrustRuleMessage
        XCTAssertNotNil(trustRuleMsg)
        XCTAssertNil(trustRuleMsg?.executionTarget)
        XCTAssertNil(trustRuleMsg?.principalKind)
        XCTAssertNil(trustRuleMsg?.principalId)
        XCTAssertNil(trustRuleMsg?.principalVersion)
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(model.toolName, "")
        XCTAssertEqual(model.inputJSON, "{}")
        XCTAssertEqual(model.workingDir, "")
        XCTAssertTrue(model.isInteractive)
        XCTAssertFalse(model.forcePromptSideEffects)
        XCTAssertEqual(model.executionTarget, "")
        XCTAssertEqual(model.principalKind, "")
        XCTAssertEqual(model.principalId, "")
        XCTAssertEqual(model.principalVersion, "")
        XCTAssertFalse(model.isSimulating)
        XCTAssertNil(model.lastResult)
        XCTAssertNil(model.lastError)
    }
}
