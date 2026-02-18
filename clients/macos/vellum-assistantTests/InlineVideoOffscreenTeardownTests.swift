import XCTest
@testable import VellumAssistantLib

@MainActor
final class InlineVideoOffscreenTeardownTests: XCTestCase {

    private var sut: InlineVideoEmbedStateManager!

    override func setUp() {
        super.setUp()
        sut = InlineVideoEmbedStateManager()
    }

    override func tearDown() {
        sut = nil
        super.tearDown()
    }

    // MARK: - Reset from playing

    func testResetFromPlayingReturnsToPlaceholder() {
        sut.requestPlay()
        sut.didStartPlaying()
        XCTAssertEqual(sut.state, .playing)

        sut.reset()
        XCTAssertEqual(sut.state, .placeholder)
    }

    // MARK: - Reset from initializing

    func testResetFromInitializingReturnsToPlaceholder() {
        sut.requestPlay()
        XCTAssertEqual(sut.state, .initializing)

        sut.reset()
        XCTAssertEqual(sut.state, .placeholder)
    }

    // MARK: - Reset from placeholder (no-op)

    func testResetFromPlaceholderRemainsPlaceholder() {
        XCTAssertEqual(sut.state, .placeholder)

        sut.reset()
        XCTAssertEqual(sut.state, .placeholder)
    }

    // MARK: - Reset from failed

    func testResetFromFailedReturnsToPlaceholder() {
        sut.didFail("Load error")
        XCTAssertEqual(sut.state, .failed("Load error"))

        sut.reset()
        XCTAssertEqual(sut.state, .placeholder)
    }

    // MARK: - Full lifecycle: play → teardown → replay

    func testPlayTeardownReplayCycle() {
        // First play cycle
        sut.requestPlay()
        sut.didStartPlaying()
        XCTAssertEqual(sut.state, .playing)

        // Simulate offscreen teardown
        sut.reset()
        XCTAssertEqual(sut.state, .placeholder)

        // Replay after scrolling back onscreen
        sut.requestPlay()
        XCTAssertEqual(sut.state, .initializing)

        sut.didStartPlaying()
        XCTAssertEqual(sut.state, .playing)
    }
}
