import XCTest
@testable import VellumAssistantLib

@MainActor
final class InlineVideoEmbedStateTests: XCTestCase {

    private var sut: InlineVideoEmbedStateManager!

    override func setUp() {
        super.setUp()
        sut = InlineVideoEmbedStateManager()
    }

    override func tearDown() {
        sut = nil
        super.tearDown()
    }

    // MARK: - Initial state

    func testInitialStateIsPlaceholder() {
        XCTAssertEqual(sut.state, .placeholder)
    }

    // MARK: - requestPlay

    func testRequestPlayTransitionsToInitializing() {
        sut.requestPlay()
        XCTAssertEqual(sut.state, .initializing)
    }

    func testRequestPlayFromPlayingIsIgnored() {
        sut.requestPlay()
        sut.didStartPlaying()
        XCTAssertEqual(sut.state, .playing)

        sut.requestPlay()
        XCTAssertEqual(sut.state, .playing)
    }

    func testRequestPlayFromInitializingIsIgnored() {
        sut.requestPlay()
        XCTAssertEqual(sut.state, .initializing)

        sut.requestPlay()
        XCTAssertEqual(sut.state, .initializing)
    }

    func testRequestPlayFromFailedTransitionsToInitializing() {
        sut.didFail("Network error")
        XCTAssertEqual(sut.state, .failed("Network error"))

        sut.requestPlay()
        XCTAssertEqual(sut.state, .initializing)
    }

    // MARK: - didStartPlaying

    func testDidStartPlayingTransitionsToPlaying() {
        sut.requestPlay()
        sut.didStartPlaying()
        XCTAssertEqual(sut.state, .playing)
    }

    // MARK: - didFail

    func testDidFailTransitionsToFailedWithMessage() {
        sut.requestPlay()
        sut.didFail("Timed out")
        XCTAssertEqual(sut.state, .failed("Timed out"))
    }

    // MARK: - reset

    func testResetReturnsToPlaceholder() {
        sut.requestPlay()
        sut.didStartPlaying()
        XCTAssertEqual(sut.state, .playing)

        sut.reset()
        XCTAssertEqual(sut.state, .placeholder)
    }

    // MARK: - Full lifecycle

    func testFullLifecycle() {
        XCTAssertEqual(sut.state, .placeholder)

        sut.requestPlay()
        XCTAssertEqual(sut.state, .initializing)

        sut.didStartPlaying()
        XCTAssertEqual(sut.state, .playing)

        sut.reset()
        XCTAssertEqual(sut.state, .placeholder)
    }
}
