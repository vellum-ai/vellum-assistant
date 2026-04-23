import XCTest
@testable import VellumAssistantLib

// MARK: - AppleContainersPodRuntime Tests

@available(macOS 26.0, *)
final class PodRuntimeTests: XCTestCase {

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
        XCTAssertEqual(config.rootfsSizeInBytes, 10 * 1024 * 1024 * 1024)
        XCTAssertNil(config.bootstrapSecret)
        XCTAssertNil(config.cesServiceToken)
        XCTAssertFalse(config.skipRegistryPull)
    }

    func testMissingImageRefErrorDescription() {
        let error = AppleContainersPodRuntime.PodRuntimeError.missingImageRef(.gateway)
        XCTAssertTrue(error.errorDescription!.contains("vellum-gateway"))
    }

    func testLocalImageNotFoundErrorDescription() {
        let error = AppleContainersPodRuntime.PodRuntimeError.localImageNotFound("docker.io/vellumai/vellum-assistant:latest")
        XCTAssertTrue(error.errorDescription!.contains("vellum-assistant"))
        XCTAssertTrue(error.errorDescription!.contains("locally-built image not found".lowercased()) || error.errorDescription!.contains("Locally-built image not found"))
    }
}

// MARK: - LineBufferedWriter Tests

final class LineBufferedWriterTests: XCTestCase {

    func testSplitsLines() throws {
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

    func testFlushesPartialLine() throws {
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

    func testHandlesMultipleWrites() throws {
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
