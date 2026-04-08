import XCTest
@testable import VellumAssistantLib

final class PodRuntimeTests: XCTestCase {

    // MARK: - Configuration defaults

    func testDefaultConfigurationValues() {
        let config = AppleContainersPodRuntime.Configuration(
            instanceName: "test",
            serviceImageRefs: [
                .assistant: "vellumai/vellum-assistant:latest",
                .gateway: "vellumai/vellum-gateway:latest",
                .credentialExecutor: "vellumai/vellum-credential-executor:latest",
            ],
            instanceDir: URL(fileURLWithPath: "/tmp/test"),
            signingKey: "abc123"
        )
        XCTAssertEqual(config.cpus, 4)
        XCTAssertEqual(config.memoryInBytes, 2 * 1024 * 1024 * 1024)
        XCTAssertEqual(config.rootfsSizeInBytes, 512 * 1024 * 1024)
        XCTAssertNil(config.bootstrapSecret)
        XCTAssertNil(config.cesServiceToken)
    }

    // MARK: - Missing image ref

    func testMissingImageRefErrorDescription() {
        let error = AppleContainersPodRuntime.PodRuntimeError.missingImageRef(.gateway)
        XCTAssertTrue(error.errorDescription!.contains("vellum-gateway"))
    }

    // MARK: - LineBufferedWriter

    func testLineBufferedWriterSplitsLines() throws {
        var received: [String] = []
        let (stream, continuation) = AsyncStream<String>.makeStream()
        let writer = LineBufferedWriter(continuation: continuation)

        try writer.write(Data("hello\nworld\n".utf8))
        try writer.close()

        let expectation = expectation(description: "stream")
        Task {
            for await line in stream {
                received.append(line)
            }
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1)

        XCTAssertEqual(received, ["hello", "world"])
    }

    func testLineBufferedWriterFlushesPartialLine() throws {
        var received: [String] = []
        let (stream, continuation) = AsyncStream<String>.makeStream()
        let writer = LineBufferedWriter(continuation: continuation)

        try writer.write(Data("no newline".utf8))
        try writer.close()

        let expectation = expectation(description: "stream")
        Task {
            for await line in stream {
                received.append(line)
            }
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1)

        XCTAssertEqual(received, ["no newline"])
    }

    func testLineBufferedWriterHandlesMultipleWrites() throws {
        var received: [String] = []
        let (stream, continuation) = AsyncStream<String>.makeStream()
        let writer = LineBufferedWriter(continuation: continuation)

        try writer.write(Data("hel".utf8))
        try writer.write(Data("lo\nwor".utf8))
        try writer.write(Data("ld\n".utf8))
        try writer.close()

        let expectation = expectation(description: "stream")
        Task {
            for await line in stream {
                received.append(line)
            }
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1)

        XCTAssertEqual(received, ["hello", "world"])
    }
}
