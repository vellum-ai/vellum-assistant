import Foundation
import Testing

@testable import MacHelperCore

@Suite("AppleScriptInputTakeover.takesOver")
struct AppleScriptInputTakeoverTests {
    @Test("asking an app to act leaves the user's input alone")
    func ordinaryAppScripting() {
        let script = """
            tell application "Mail" to make new outgoing message with properties {subject:"Hi"}
            """
        #expect(AppleScriptInputTakeover.takesOver(script: script) == false)
    }

    @Test("a keystroke through System Events takes over")
    func systemEventsKeystroke() {
        #expect(AppleScriptInputTakeover.takesOver(script: #"tell application "System Events" to keystroke "a""#))
    }

    @Test("System Events matches across case and whitespace")
    func systemEventsNormalized() {
        let script = "tell application \"SYSTEM\n\t  EVENTS\"\n  key code 36\nend tell"
        #expect(AppleScriptInputTakeover.takesOver(script: script))
    }

    @Test("activating an app takes over focus")
    func activate() {
        #expect(AppleScriptInputTakeover.takesOver(script: #"tell application "Safari" to activate"#))
        #expect(AppleScriptInputTakeover.takesOver(script: "tell application \"Safari\"\n\tActivate\nend tell"))
    }

    @Test("a word that only contains activate is not a takeover")
    func activateSubstring() {
        #expect(AppleScriptInputTakeover.takesOver(script: #"return "activated""#) == false)
        #expect(AppleScriptInputTakeover.takesOver(script: #"return "deactivate""#) == false)
    }
}
