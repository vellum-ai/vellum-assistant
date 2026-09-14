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
        #expect(AppleScriptInputTakeover.takesOver(script: #"tell application "Music" to play"#) == false)
    }

    @Test("a read-only System Events query is not a takeover")
    func systemEventsQuery() {
        let script = #"tell application "System Events" to get name of first process whose frontmost is true"#
        #expect(AppleScriptInputTakeover.takesOver(script: script) == false)
    }

    @Test("a keystroke through System Events takes over")
    func systemEventsKeystroke() {
        #expect(AppleScriptInputTakeover.takesOver(script: #"tell application "System Events" to keystroke "a""#))
    }

    @Test("System Events addressed by bundle id still takes over")
    func systemEventsBundleId() {
        #expect(AppleScriptInputTakeover.takesOver(script: #"tell application id "com.apple.systemevents" to key code 36"#))
    }

    @Test("System Events input matches across case and whitespace")
    func systemEventsNormalized() {
        let script = "tell application \"SYSTEM\n\t  EVENTS\"\n  KEY   CODE 36\nend tell"
        #expect(AppleScriptInputTakeover.takesOver(script: script))
    }

    @Test("activating or reopening an app takes over focus")
    func activateAndReopen() {
        #expect(AppleScriptInputTakeover.takesOver(script: #"tell application "Safari" to activate"#))
        #expect(AppleScriptInputTakeover.takesOver(script: "tell application \"Safari\"\n\tActivate\nend tell"))
        #expect(AppleScriptInputTakeover.takesOver(script: #"tell application "Notes" to reopen"#))
        #expect(AppleScriptInputTakeover.takesOver(script: #"open location "https://example.com""#))
    }

    @Test("a word in a string or comment is not a takeover")
    func wordsInLiteralsAndComments() {
        #expect(AppleScriptInputTakeover.takesOver(script: #"display notification "activate your trial""#) == false)
        #expect(AppleScriptInputTakeover.takesOver(script: "-- activate later\ntell application \"Music\" to play") == false)
        #expect(AppleScriptInputTakeover.takesOver(script: "(* keystroke *) tell application \"System Events\" to get name of processes") == false)
        #expect(AppleScriptInputTakeover.takesOver(script: #"return "activated""#) == false)
        #expect(AppleScriptInputTakeover.takesOver(script: #"tell application "Finder" to deactivate"#) == false)
    }
}
