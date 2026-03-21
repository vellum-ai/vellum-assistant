import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ToolPermissionTesterModelTests: XCTestCase {

    private var daemonClient: GatewayConnectionManager!
    private var mockToolClient: MockToolClient!
    private var mockTrustRuleClient: MockTrustRuleClient!
    private var model: ToolPermissionTesterModel!

    override func setUp() {
        super.setUp()
        daemonClient = GatewayConnectionManager()
        daemonClient.isConnected = true
        mockToolClient = MockToolClient()
        mockTrustRuleClient = MockTrustRuleClient()
        model = ToolPermissionTesterModel(
            daemonClient: daemonClient,
            toolClient: mockToolClient,
            trustRuleClient: mockTrustRuleClient
        )
    }

    override func tearDown() {
        model = nil
        mockToolClient = nil
        mockTrustRuleClient = nil
        daemonClient = nil
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
        model.simulate()

        XCTAssertTrue(model.isSimulating)
    }

    func testSimulate_clearsLastErrorAndResult() {
        model.lastError = "previous error"
        model.lastResult = SimulationResult(
            decision: "allow", riskLevel: "low", reason: "test",
            matchedRuleId: nil, promptPayload: nil,
            snapshotToolName: "", snapshotInputJSON: "{}", snapshotExecutionTarget: nil
        )

        model.toolName = "host_bash"
        model.simulate()

        XCTAssertNil(model.lastError)
        XCTAssertNil(model.lastResult)
    }

    func testSimulate_sendsMessage() {
        mockToolClient.simulateResponse = ToolPermissionSimulateResponseMessage(
            type: "tool_permission_simulate_response",
            success: true, decision: "allow", riskLevel: "low", reason: "test",
            promptPayload: nil, executionTarget: nil, matchedRuleId: nil, error: nil
        )

        model.toolName = "host_bash"
        model.fieldDescriptors = [ToolFieldDescriptor(id: "command", fieldType: .string, description: nil, isRequired: true)]
        model.fieldValues = ["command": "echo hello"]
        model.fieldEnabled = ["command": true]
        model.workingDir = "/tmp"
        model.isInteractive = false
        model.forcePromptSideEffects = true
        model.simulate()

        let predicate = NSPredicate { _, _ in !self.model.isSimulating }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(mockToolClient.simulateToolPermissionCalls.count, 1)
        let call = mockToolClient.simulateToolPermissionCalls[0]
        XCTAssertEqual(call.toolName, "host_bash")
        XCTAssertEqual(call.workingDir, "/tmp")
        XCTAssertEqual(call.isInteractive, false)
        XCTAssertEqual(call.forcePromptSideEffects, true)
    }

    func testSimulate_emptyOptionalFieldsSendNil() {
        mockToolClient.simulateResponse = ToolPermissionSimulateResponseMessage(
            type: "tool_permission_simulate_response",
            success: true, decision: "allow", riskLevel: "low", reason: "test",
            promptPayload: nil, executionTarget: nil, matchedRuleId: nil, error: nil
        )

        model.toolName = "host_bash"
        model.workingDir = ""

        model.simulate()

        let predicate = NSPredicate { _, _ in !self.model.isSimulating }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(mockToolClient.simulateToolPermissionCalls.count, 1)
        let call = mockToolClient.simulateToolPermissionCalls[0]
        XCTAssertNil(call.workingDir)
    }

    func testSimulate_sendFailure_setsError() {
        mockToolClient.simulateError = NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "socket closed"])

        model.toolName = "host_bash"
        model.simulate()

        let predicate = NSPredicate { _, _ in !self.model.isSimulating }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertNotNil(model.lastError)
        XCTAssertTrue(model.lastError?.contains("socket closed") == true)
        XCTAssertFalse(model.isSimulating)
    }

    func testSimulate_handlesSuccessResponse() {
        mockToolClient.simulateResponse = ToolPermissionSimulateResponseMessage(
            type: "tool_permission_simulate_response",
            success: true,
            decision: "allow",
            riskLevel: "low",
            reason: "Matched trust rule",
            promptPayload: nil,
            executionTarget: nil,
            matchedRuleId: "rule-42",
            error: nil
        )

        model.toolName = "host_bash"
        model.simulate()

        let predicate = NSPredicate { _, _ in !self.model.isSimulating }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertFalse(model.isSimulating)
        XCTAssertNotNil(model.lastResult)
        XCTAssertEqual(model.lastResult?.decision, "allow")
        XCTAssertEqual(model.lastResult?.riskLevel, "low")
        XCTAssertEqual(model.lastResult?.reason, "Matched trust rule")
        XCTAssertEqual(model.lastResult?.matchedRuleId, "rule-42")
    }

    func testSimulate_handlesErrorResponse() {
        mockToolClient.simulateResponse = ToolPermissionSimulateResponseMessage(
            type: "tool_permission_simulate_response",
            success: false,
            decision: nil,
            riskLevel: nil,
            reason: nil,
            promptPayload: nil,
            executionTarget: nil,
            matchedRuleId: nil,
            error: "Tool not found"
        )

        model.toolName = "host_bash"
        model.simulate()

        let predicate = NSPredicate { _, _ in !self.model.isSimulating }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertFalse(model.isSimulating)
        XCTAssertEqual(model.lastError, "Tool not found")
        XCTAssertNil(model.lastResult)
    }

    // MARK: - allowOnce()

    func testAllowOnce_setsLocalOverrideLabel() {
        model.lastResult = SimulationResult(
            decision: "prompt", riskLevel: "medium", reason: "test",
            matchedRuleId: nil, promptPayload: nil,
            snapshotToolName: "", snapshotInputJSON: "{}", snapshotExecutionTarget: nil
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
            matchedRuleId: nil, promptPayload: nil,
            snapshotToolName: "", snapshotInputJSON: "{}", snapshotExecutionTarget: nil
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
        mockToolClient.simulateResponse = ToolPermissionSimulateResponseMessage(
            type: "tool_permission_simulate_response",
            success: true, decision: "allow", riskLevel: "low", reason: "Matched trust rule",
            promptPayload: nil, executionTarget: "host", matchedRuleId: nil, error: nil
        )

        model.toolName = "host_bash"
        model.lastResult = SimulationResult(
            decision: "prompt", riskLevel: "medium", reason: "test",
            matchedRuleId: nil, promptPayload: nil,
            snapshotToolName: "host_bash", snapshotInputJSON: "{}", snapshotExecutionTarget: "host"
        )

        model.alwaysAllow(pattern: "echo *", scope: "project")

        let predicate = NSPredicate { _, _ in self.mockTrustRuleClient.addTrustRuleCalls.count >= 1 }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(mockTrustRuleClient.addTrustRuleCalls.count, 1)
        let trustCall = mockTrustRuleClient.addTrustRuleCalls[0]
        XCTAssertEqual(trustCall.toolName, "host_bash")
        XCTAssertEqual(trustCall.pattern, "echo *")
        XCTAssertEqual(trustCall.scope, "project")
        XCTAssertEqual(trustCall.decision, "allow")
        XCTAssertEqual(trustCall.executionTarget, "host")

        // Re-simulate should have been called.
        XCTAssertGreaterThanOrEqual(mockToolClient.simulateToolPermissionCalls.count, 1)
    }

    func testAlwaysAllow_highRisk_usesAlwaysAllowHighRiskDecision() {
        mockToolClient.simulateResponse = ToolPermissionSimulateResponseMessage(
            type: "tool_permission_simulate_response",
            success: true, decision: "allow", riskLevel: "low", reason: "ok",
            promptPayload: nil, executionTarget: nil, matchedRuleId: nil, error: nil
        )

        model.toolName = "host_bash"
        model.lastResult = SimulationResult(
            decision: "prompt", riskLevel: "high", reason: "dangerous",
            matchedRuleId: nil, promptPayload: nil,
            snapshotToolName: "", snapshotInputJSON: "{}", snapshotExecutionTarget: nil
        )

        model.alwaysAllow(pattern: "rm -rf *", scope: "global")

        let predicate = NSPredicate { _, _ in self.mockTrustRuleClient.addTrustRuleCalls.count >= 1 }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        let trustCall = mockTrustRuleClient.addTrustRuleCalls[0]
        XCTAssertEqual(trustCall.decision, "allow")
        XCTAssertEqual(trustCall.allowHighRisk, true)
    }

    func testAlwaysAllow_mediumRisk_doesNotSetAllowHighRisk() {
        mockToolClient.simulateResponse = ToolPermissionSimulateResponseMessage(
            type: "tool_permission_simulate_response",
            success: true, decision: "allow", riskLevel: "low", reason: "ok",
            promptPayload: nil, executionTarget: nil, matchedRuleId: nil, error: nil
        )

        model.toolName = "host_bash"
        model.lastResult = SimulationResult(
            decision: "prompt", riskLevel: "medium", reason: "test",
            matchedRuleId: nil, promptPayload: nil,
            snapshotToolName: "", snapshotInputJSON: "{}", snapshotExecutionTarget: nil
        )

        model.alwaysAllow(pattern: "echo *", scope: "project")

        let predicate = NSPredicate { _, _ in self.mockTrustRuleClient.addTrustRuleCalls.count >= 1 }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        let trustCall = mockTrustRuleClient.addTrustRuleCalls[0]
        XCTAssertEqual(trustCall.decision, "allow")
        XCTAssertNil(trustCall.allowHighRisk)
    }

    func testAlwaysAllow_emptyMetadata_doesNotPassNilFields() {
        mockToolClient.simulateResponse = ToolPermissionSimulateResponseMessage(
            type: "tool_permission_simulate_response",
            success: true, decision: "allow", riskLevel: "low", reason: "ok",
            promptPayload: nil, executionTarget: nil, matchedRuleId: nil, error: nil
        )

        model.toolName = "host_bash"
        model.lastResult = SimulationResult(
            decision: "prompt", riskLevel: "low", reason: "test",
            matchedRuleId: nil, promptPayload: nil,
            snapshotToolName: "", snapshotInputJSON: "{}", snapshotExecutionTarget: nil
        )

        model.alwaysAllow(pattern: "*", scope: "global")

        let predicate = NSPredicate { _, _ in self.mockTrustRuleClient.addTrustRuleCalls.count >= 1 }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        let trustCall = mockTrustRuleClient.addTrustRuleCalls[0]
        XCTAssertNil(trustCall.executionTarget)
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(model.toolName, "")
        XCTAssertEqual(model.workingDir, "")
        XCTAssertTrue(model.isInteractive)
        XCTAssertFalse(model.forcePromptSideEffects)
        XCTAssertFalse(model.isSimulating)
        XCTAssertNil(model.lastResult)
        XCTAssertNil(model.lastError)
    }
}
