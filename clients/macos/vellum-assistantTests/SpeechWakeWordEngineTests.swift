import XCTest
@testable import VellumAssistantLib

/// Tests for `SpeechWakeWordEngine` pure logic — keyword matching, keyword update,
/// and exponential backoff calculations. Does NOT require audio hardware.
final class SpeechWakeWordEngineTests: XCTestCase {

    // MARK: - Keyword Initialization

    func testDefaultKeywordIsComputer() {
        let engine = SpeechWakeWordEngine()
        XCTAssertEqual(engine.keyword, "computer")
    }

    func testCustomKeywordIsStored() {
        let engine = SpeechWakeWordEngine(keyword: "jarvis")
        XCTAssertEqual(engine.keyword, "jarvis")
    }

    func testEmptyKeywordDefaultsToComputer() {
        let engine = SpeechWakeWordEngine(keyword: "")
        XCTAssertEqual(engine.keyword, "computer")
    }

    func testWhitespaceOnlyKeywordDefaultsToComputer() {
        let engine = SpeechWakeWordEngine(keyword: "   \n  ")
        XCTAssertEqual(engine.keyword, "computer")
    }

    func testKeywordIsTrimmed() {
        let engine = SpeechWakeWordEngine(keyword: "  hey vellum  ")
        XCTAssertEqual(engine.keyword, "hey vellum")
    }

    // MARK: - updateKeyword

    func testUpdateKeywordChangesKeyword() {
        let engine = SpeechWakeWordEngine(keyword: "computer")
        engine.updateKeyword("jarvis")
        XCTAssertEqual(engine.keyword, "jarvis")
    }

    func testUpdateKeywordTrimsWhitespace() {
        let engine = SpeechWakeWordEngine(keyword: "computer")
        engine.updateKeyword("  hey vellum  ")
        XCTAssertEqual(engine.keyword, "hey vellum")
    }

    func testUpdateKeywordEmptyDefaultsToComputer() {
        let engine = SpeechWakeWordEngine(keyword: "jarvis")
        engine.updateKeyword("")
        XCTAssertEqual(engine.keyword, "computer")
    }

    func testUpdateKeywordSameValueIsNoOp() {
        let engine = SpeechWakeWordEngine(keyword: "computer")
        // If it were not a no-op, it would call restartSession() which would crash
        // since the engine is not running. No crash = success.
        engine.updateKeyword("computer")
        XCTAssertEqual(engine.keyword, "computer")
    }

    // MARK: - Exponential Backoff Calculation

    /// Verify the backoff formula: pow(2, consecutiveFailures) capped at maxBackoffSeconds (30s).
    func testBackoffCalculation() {
        // The formula used in the engine: min(pow(2.0, Double(consecutiveFailures)), maxBackoffSeconds)
        let maxBackoff: TimeInterval = 30

        XCTAssertEqual(min(pow(2.0, 1.0), maxBackoff), 2.0, "1 failure → 2s")
        XCTAssertEqual(min(pow(2.0, 2.0), maxBackoff), 4.0, "2 failures → 4s")
        XCTAssertEqual(min(pow(2.0, 3.0), maxBackoff), 8.0, "3 failures → 8s")
        XCTAssertEqual(min(pow(2.0, 4.0), maxBackoff), 16.0, "4 failures → 16s")
        XCTAssertEqual(min(pow(2.0, 5.0), maxBackoff), 30.0, "5 failures → capped at 30s")
        XCTAssertEqual(min(pow(2.0, 10.0), maxBackoff), 30.0, "10 failures → still capped at 30s")
    }

    // MARK: - Keyword Pattern Matching (via onWakeWordDetected callback)

    func testKeywordDetectedInTranscription() {
        // checkForKeyword is private, so we verify the regex pattern that the
        // engine compiles from the keyword matches expected transcriptions.
        let pattern = try! Regex<Substring>("(?i)\\b\(NSRegularExpression.escapedPattern(for: "computer"))\\b")
        XCTAssertTrue("hey computer how are you".contains(pattern))
        XCTAssertTrue("computer".contains(pattern))
        XCTAssertFalse("hey how are you".contains(pattern))
    }

    func testKeywordMatchIsCaseInsensitive() {
        let pattern = try! Regex<Substring>("(?i)\\b\(NSRegularExpression.escapedPattern(for: "computer"))\\b")
        XCTAssertTrue("Hey COMPUTER".contains(pattern))
        XCTAssertTrue("Hey Computer".contains(pattern))
        XCTAssertTrue("hey computer".contains(pattern))
    }

    func testKeywordMatchRequiresWordBoundary() {
        let pattern = try! Regex<Substring>("(?i)\\b\(NSRegularExpression.escapedPattern(for: "computer"))\\b")
        XCTAssertFalse("computerize".contains(pattern), "Should not match partial word")
        XCTAssertFalse("supercomputer".contains(pattern), "Should not match partial word")
        XCTAssertTrue("my computer is fast".contains(pattern), "Should match whole word")
    }

    func testMultiWordKeywordPattern() {
        let pattern = try! Regex<Substring>("(?i)\\b\(NSRegularExpression.escapedPattern(for: "hey vellum"))\\b")
        XCTAssertTrue("hey vellum what's up".contains(pattern))
        XCTAssertFalse("heyvellum".contains(pattern))
    }

    func testSpecialCharacterKeywordEscaping() {
        // Verify that special regex characters in a keyword are properly escaped
        let escaped = NSRegularExpression.escapedPattern(for: "hey.vellum")
        let pattern = try? Regex<Substring>("(?i)\\b\(escaped)\\b")
        XCTAssertNotNil(pattern, "Should compile even with dots in keyword")
        // The dot is escaped, so it should match literally
        XCTAssertTrue("hey.vellum".contains(pattern!))
        XCTAssertFalse("heyXvellum".contains(pattern!), "Escaped dot should not match arbitrary char")
    }
}
