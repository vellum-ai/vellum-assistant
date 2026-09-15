import Foundation
import Testing

@testable import MacHelperCore

@Suite("ActionSequence")
struct ActionSequenceTests {
    @Test("every batchable action maps to its single-action tool")
    func mapsActions() {
        #expect(ActionSequence.toolName(forAction: "key") == "computer_use_key")
        #expect(ActionSequence.toolName(forAction: "type_text") == "computer_use_type_text")
        #expect(ActionSequence.toolName(forAction: "type") == "computer_use_type_text")
        #expect(ActionSequence.toolName(forAction: "right_click") == "computer_use_right_click")
        #expect(ActionSequence.toolName(forAction: "open_app") == "computer_use_open_app")
    }

    @Test("drag and AppleScript cannot be batched")
    func rejectsUnbatchable() {
        #expect(ActionSequence.toolName(forAction: "drag") == nil)
        #expect(ActionSequence.toolName(forAction: "run_applescript") == nil)
    }

    @Test("a well-formed batch has no problem")
    func acceptsValidBatch() {
        #expect(ActionSequence.problem(withActions: ["open_app", "key", "type_text", "key"]) == nil)
    }

    @Test("an empty, oversized or unknown batch is refused before running")
    func refusesMalformedBatches() {
        #expect(ActionSequence.problem(withActions: []) != nil)
        #expect(ActionSequence.problem(withActions: Array(repeating: "key", count: ActionSequence.maxActions + 1)) != nil)
        let unknown = ActionSequence.problem(withActions: ["key", "drag"])
        #expect(unknown?.contains("Action 2") == true)
        #expect(ActionSequence.problem(withActions: ["key", nil]) != nil)
    }
}
