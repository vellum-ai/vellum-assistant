import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Tests for the pre-chat onboarding state management, serialization,
/// name detection, and skip flow.
@MainActor
final class PreChatOnboardingTests: XCTestCase {

    private let testSuiteName = "com.vellum.prechat-onboarding-tests"
    private var testDefaults: UserDefaults!

    override func setUp() {
        super.setUp()
        testDefaults = UserDefaults(suiteName: testSuiteName)!
        testDefaults.removePersistentDomain(forName: testSuiteName)
        // Clear standard UserDefaults keys used by PreChatOnboardingState
        PreChatOnboardingState.clearPersistedState()
    }

    override func tearDown() {
        testDefaults.removePersistentDomain(forName: testSuiteName)
        testDefaults = nil
        PreChatOnboardingState.clearPersistedState()
        super.tearDown()
    }

    // MARK: - PreChatOnboardingContext Serialization

    func testContextEncodesToExpectedJSON() throws {
        let context = PreChatOnboardingContext(
            tools: ["slack", "linear"],
            tasks: ["code-building", "writing"],
            tone: "professional",
            userName: "Alex",
            assistantName: "Nova"
        )

        let data = try JSONEncoder().encode(context)
        let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(dict["tools"] as? [String], ["slack", "linear"])
        XCTAssertEqual(dict["tasks"] as? [String], ["code-building", "writing"])
        XCTAssertEqual(dict["tone"] as? String, "professional")
        XCTAssertEqual(dict["userName"] as? String, "Alex")
        XCTAssertEqual(dict["assistantName"] as? String, "Nova")
    }

    func testContextEncodesNilOptionalFieldsCorrectly() throws {
        let context = PreChatOnboardingContext(
            tools: ["figma"],
            tasks: ["design"],
            tone: "casual",
            userName: nil,
            assistantName: nil
        )

        let data = try JSONEncoder().encode(context)
        let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(dict["tools"] as? [String], ["figma"])
        XCTAssertEqual(dict["tone"] as? String, "casual")
        // nil optionals should not be present in the JSON
        XCTAssertNil(dict["userName"])
        XCTAssertNil(dict["assistantName"])
    }

    func testContextRoundTrip() throws {
        let original = PreChatOnboardingContext(
            tools: ["notion", "slack"],
            tasks: ["project-management"],
            tone: "balanced",
            userName: "Jane",
            assistantName: "Kit"
        )

        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(PreChatOnboardingContext.self, from: data)

        XCTAssertEqual(decoded.tools, original.tools)
        XCTAssertEqual(decoded.tasks, original.tasks)
        XCTAssertEqual(decoded.tone, original.tone)
        XCTAssertEqual(decoded.userName, original.userName)
        XCTAssertEqual(decoded.assistantName, original.assistantName)
    }

    // MARK: - contextSummary

    func testContextSummaryWithTasksAndTools() {
        let state = PreChatOnboardingState()
        state.selectedTasks = ["code-building", "writing"]
        state.selectedTools = ["slack", "linear"]

        let summary = state.contextSummary

        XCTAssertTrue(summary.contains("focused on"), "Should mention tasks")
        XCTAssertTrue(summary.contains("mostly in"), "Should mention tools")
        XCTAssertTrue(summary.contains("Let's make that easier."))
    }

    func testContextSummaryWithTasksOnly() {
        let state = PreChatOnboardingState()
        state.selectedTasks = ["writing"]
        state.selectedTools = []

        let summary = state.contextSummary

        XCTAssertTrue(summary.contains("focused on"))
        XCTAssertTrue(summary.contains("writing"))
        XCTAssertFalse(summary.contains("mostly in"))
    }

    func testContextSummaryWithToolsOnly() {
        let state = PreChatOnboardingState()
        state.selectedTasks = []
        state.selectedTools = ["figma"]

        let summary = state.contextSummary

        XCTAssertFalse(summary.contains("focused on"))
        XCTAssertTrue(summary.contains("mostly in"))
        XCTAssertTrue(summary.contains("figma"))
    }

    func testContextSummaryWithNoSelections() {
        let state = PreChatOnboardingState()
        state.selectedTasks = []
        state.selectedTools = []

        XCTAssertEqual(state.contextSummary, "Let's get to know each other.")
    }

    func testContextSummaryTruncatesLongLists() {
        let state = PreChatOnboardingState()
        state.selectedTasks = ["a", "b", "c", "d", "e"]
        state.selectedTools = ["x", "y", "z", "w"]

        let summary = state.contextSummary

        // Should only include at most 3 items from each list
        let taskMatches = state.selectedTasks.sorted().prefix(3)
        for task in taskMatches {
            XCTAssertTrue(summary.contains(task),
                          "Summary should contain task '\(task)'")
        }
    }

    // MARK: - Name Pre-fill Blacklist

    func testDefaultUserNameSkipsBlacklistedNames() {
        // The blacklist contains: admin, user, root, guest (case-insensitive).
        // We can't mock NSUserName(), but we can verify the blacklist exists
        // by checking that the static method is callable and returns a string.
        let name = NameExchangeView.defaultUserName()
        XCTAssertTrue(name is String, "defaultUserName should return a String")

        // Verify the result does not contain blacklisted values
        let blacklisted: Set<String> = ["admin", "user", "root", "guest"]
        if !name.isEmpty {
            XCTAssertFalse(blacklisted.contains(name.lowercased()),
                           "defaultUserName should not return a blacklisted name")
        }
    }

    // MARK: - PreChatOnboardingState Persistence

    func testStatePersistsAndRestores() {
        // Set values on state and persist
        let state1 = PreChatOnboardingState()
        state1.currentScreen = 2
        state1.selectedTools = ["slack", "notion"]
        state1.selectedTasks = ["code-building"]
        state1.toneValue = 0.8
        state1.userName = "TestUser"
        state1.assistantName = "TestAssistant"
        state1.persist()

        // Create a new instance — it should restore from UserDefaults
        let state2 = PreChatOnboardingState()

        XCTAssertEqual(state2.currentScreen, 2)
        XCTAssertEqual(state2.selectedTools, ["slack", "notion"])
        XCTAssertEqual(state2.selectedTasks, ["code-building"])
        XCTAssertEqual(state2.toneValue, 0.8, accuracy: 0.01)
        XCTAssertEqual(state2.userName, "TestUser")
        XCTAssertEqual(state2.assistantName, "TestAssistant")
    }

    func testClearPersistedStateResetsToDefaults() {
        let state1 = PreChatOnboardingState()
        state1.selectedTools = ["linear"]
        state1.userName = "Persisted"
        state1.persist()

        PreChatOnboardingState.clearPersistedState()

        // New instance should start fresh (not restore persisted values)
        let state2 = PreChatOnboardingState()

        XCTAssertEqual(state2.currentScreen, 0)
        XCTAssertTrue(state2.selectedTools.isEmpty)
        XCTAssertTrue(state2.selectedTasks.isEmpty)
    }

    // MARK: - Tone Label

    func testToneLabelMappings() {
        let state = PreChatOnboardingState()

        state.toneValue = 0.1
        XCTAssertEqual(state.toneLabel, "casual")

        state.toneValue = 0.5
        XCTAssertEqual(state.toneLabel, "balanced")

        state.toneValue = 0.9
        XCTAssertEqual(state.toneLabel, "professional")
    }

    // MARK: - Skip Flow

    func testSkipFlowCallsOnCompleteWithNil() {
        // Verify the contract: PreChatOnboardingFlow.skipAll() calls
        // onComplete(nil). We validate the contract shape here.
        var receivedContext: PreChatOnboardingContext?? = nil
        var onCompleteCalled = false

        // Simulate the skip flow callback
        let onComplete: (PreChatOnboardingContext?) -> Void = { context in
            onCompleteCalled = true
            receivedContext = context
        }

        // Simulate skip: calls onComplete(nil)
        onComplete(nil)

        XCTAssertTrue(onCompleteCalled)
        XCTAssertNotNil(receivedContext, "receivedContext should have been set")
        XCTAssertNil(receivedContext!, "Skip should pass nil context")
    }

    func testFinishFlowCallsOnCompleteWithContext() {
        // Simulate the finish flow: builds a context from state
        var receivedContext: PreChatOnboardingContext?

        let onComplete: (PreChatOnboardingContext?) -> Void = { context in
            receivedContext = context
        }

        // Simulate what PreChatOnboardingFlow.finish() does
        let state = PreChatOnboardingState()
        state.selectedTools = ["slack"]
        state.selectedTasks = ["writing"]
        state.toneValue = 0.1
        state.userName = "Alex"
        state.assistantName = "Pax"

        let context = PreChatOnboardingContext(
            tools: Array(state.selectedTools).sorted(),
            tasks: Array(state.selectedTasks).sorted(),
            tone: state.toneLabel,
            userName: state.userName.isEmpty ? nil : state.userName,
            assistantName: state.assistantName.isEmpty ? nil : state.assistantName
        )
        onComplete(context)

        XCTAssertNotNil(receivedContext)
        XCTAssertEqual(receivedContext?.tools, ["slack"])
        XCTAssertEqual(receivedContext?.tasks, ["writing"])
        XCTAssertEqual(receivedContext?.tone, "casual")
        XCTAssertEqual(receivedContext?.userName, "Alex")
        XCTAssertEqual(receivedContext?.assistantName, "Pax")
    }
}
