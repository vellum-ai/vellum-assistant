import Foundation
import Testing
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@Suite("ChatBubble friendlyRunningLabel")
struct ChatBubbleToolHelpersTests {

    // MARK: - skill_execute

    @Test
    func skillExecuteReturnsUsingASkill() {
        let label = ChatBubble.friendlyRunningLabel("skill_execute")
        #expect(label == "Using a skill")
    }

    @Test
    func skillExecuteIgnoresInputSummary() {
        // skill_execute should always return "Using a skill" regardless of inputSummary
        let label = ChatBubble.friendlyRunningLabel("skill_execute", inputSummary: "some activity text")
        #expect(label == "Using a skill")
    }

    // MARK: - skill_load

    @Test
    func skillLoadWithNameShowsLoadingSkillName() {
        let label = ChatBubble.friendlyRunningLabel("skill_load", inputSummary: "frontend-design")
        #expect(label == "Loading frontend design")
    }

    @Test
    func skillLoadWithoutNameShowsLoadingASkill() {
        let label = ChatBubble.friendlyRunningLabel("skill_load")
        #expect(label == "Loading a skill")
    }

    @Test
    func skillLoadWithAppBuilderShowsSpecialLabel() {
        let label = ChatBubble.friendlyRunningLabel("skill_load", inputSummary: "app-builder")
        #expect(label == "Using App Builder skill")
    }

    // MARK: - Preparing... placeholder filtering

    @Test
    func preparingPlaceholderIsFilteredForSkillLoad() {
        // During preview phase, inputSummary is "Preparing..." — should not leak into label
        let label = ChatBubble.friendlyRunningLabel("skill_load", inputSummary: "Preparing...")
        #expect(label == "Loading a skill")
    }

    @Test
    func preparingPlaceholderIsFilteredForDefault() {
        let label = ChatBubble.friendlyRunningLabel("some_unknown_tool", inputSummary: "Preparing...")
        #expect(label == "Running some unknown tool")
    }
}
