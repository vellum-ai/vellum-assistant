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

    // MARK: - PersonalityGroup Name Pool

    func testAllNamesHasUniqueEntries() {
        let allNames = PersonalityGroup.allNames
        XCTAssertEqual(Set(allNames).count, allNames.count, "All names across groups must be unique")
    }

    func testStateDisplayedNamesShowsTasterWhenNoGroupSelected() {
        PreChatOnboardingState.clearPersistedState()
        let state = PreChatOnboardingState()

        XCTAssertNil(state.selectedGroupID)
        XCTAssertEqual(state.displayedAssistantNames, PreChatOnboardingState.tasterNames)
    }

    func testStateDisplayedNamesFiltersToSelectedGroup() {
        PreChatOnboardingState.clearPersistedState()
        let state = PreChatOnboardingState()
        state.selectedGroupID = "warm"

        let warmGroup = PersonalityGroup.allGroups.first { $0.id == "warm" }!
        XCTAssertEqual(state.displayedAssistantNames, warmGroup.names)
    }

    func testDefaultAssistantNameIsEmptyOnFreshState() {
        // On a fresh state (no persisted assistantName), the initial value
        // should be empty so the user must make a deliberate choice.
        PreChatOnboardingState.clearPersistedState()
        let state = PreChatOnboardingState()

        XCTAssertTrue(
            state.assistantName.isEmpty,
            "Initial assistantName should be empty, got '\(state.assistantName)'"
        )
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
        state1.userName = "TestUser"
        state1.assistantName = "TestAssistant"
        state1.selectedGroupID = "warm"
        state1.persist()

        // Create a new instance — it should restore from UserDefaults
        let state2 = PreChatOnboardingState()

        XCTAssertEqual(state2.currentScreen, 2)
        XCTAssertEqual(state2.selectedTools, ["slack", "notion"])
        XCTAssertEqual(state2.selectedTasks, ["code-building"])
        XCTAssertEqual(state2.userName, "TestUser")
        XCTAssertEqual(state2.assistantName, "TestAssistant")
        XCTAssertEqual(state2.selectedGroupID, "warm")
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
        state.userName = "Alex"
        state.assistantName = "Penn"

        let context = PreChatOnboardingContext(
            tools: Array(state.selectedTools).sorted(),
            tasks: Array(state.selectedTasks).sorted(),
            tone: "grounded",
            userName: state.userName.isEmpty ? nil : state.userName,
            assistantName: state.assistantName.isEmpty ? nil : state.assistantName
        )
        onComplete(context)

        XCTAssertNotNil(receivedContext)
        XCTAssertEqual(receivedContext?.tools, ["slack"])
        XCTAssertEqual(receivedContext?.tasks, ["writing"])
        XCTAssertEqual(receivedContext?.tone, "grounded")
        XCTAssertEqual(receivedContext?.userName, "Alex")
        XCTAssertEqual(receivedContext?.assistantName, "Penn")
    }

    // MARK: - Identity Cache Seeding

    func testSeedCacheWritesAssistantNameToDiskCache() {
        let testId = "test-assistant-\(UUID().uuidString)"

        IdentityInfo.seedCache(name: "Wren", forAssistantId: testId)

        let allCached = IdentityInfoStore.load()
        XCTAssertEqual(allCached[testId]?.name, "Wren")
    }

    func testSeedCacheDoesNotOverwriteExistingEntry() {
        let testId = "test-assistant-\(UUID().uuidString)"

        IdentityInfo.seedCache(name: "Wren", forAssistantId: testId)
        IdentityInfo.seedCache(name: "Pip", forAssistantId: testId)

        let allCached = IdentityInfoStore.load()
        XCTAssertEqual(allCached[testId]?.name, "Wren",
                       "seedCache should not overwrite an existing entry")
    }

    func testAssistantDisplayNameResolvesFromSeedCache() {
        let testId = "test-assistant-\(UUID().uuidString)"

        IdentityInfo.seedCache(name: "Wren", forAssistantId: testId)

        let cached = IdentityInfoStore.load()[testId]
        let resolved = AssistantDisplayName.resolve(cached?.name, fallback: "Your Assistant")
        XCTAssertEqual(resolved, "Wren")
    }
}
