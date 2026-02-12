import XCTest
@testable import VellumAssistantLib

@MainActor
final class DaemonClientSocketPathTests: XCTestCase {

    func testDefaultPath() {
        let path = DaemonClient.resolveSocketPath(environment: [:])
        XCTAssertEqual(path, NSHomeDirectory() + "/.vellum/vellum.sock")
    }

    func testEnvOverride() {
        let env = ["VELLUM_DAEMON_SOCKET": "/tmp/custom.sock"]
        let path = DaemonClient.resolveSocketPath(environment: env)
        XCTAssertEqual(path, "/tmp/custom.sock")
    }

    func testTildeExpansion() {
        let env = ["VELLUM_DAEMON_SOCKET": "~/my-sockets/vellum.sock"]
        let path = DaemonClient.resolveSocketPath(environment: env)
        XCTAssertEqual(path, NSHomeDirectory() + "/my-sockets/vellum.sock")
    }

    func testWhitespaceIsTrimmed() {
        let env = ["VELLUM_DAEMON_SOCKET": "  /tmp/custom.sock  "]
        let path = DaemonClient.resolveSocketPath(environment: env)
        XCTAssertEqual(path, "/tmp/custom.sock")
    }

    func testEmptyStringFallsBackToDefault() {
        let env = ["VELLUM_DAEMON_SOCKET": ""]
        let path = DaemonClient.resolveSocketPath(environment: env)
        XCTAssertEqual(path, NSHomeDirectory() + "/.vellum/vellum.sock")
    }

    func testWhitespaceOnlyFallsBackToDefault() {
        let env = ["VELLUM_DAEMON_SOCKET": "   "]
        let path = DaemonClient.resolveSocketPath(environment: env)
        XCTAssertEqual(path, NSHomeDirectory() + "/.vellum/vellum.sock")
    }

    func testNewlinesAreTrimmed() {
        let env = ["VELLUM_DAEMON_SOCKET": "/tmp/custom.sock\n"]
        let path = DaemonClient.resolveSocketPath(environment: env)
        XCTAssertEqual(path, "/tmp/custom.sock")
    }

    func testNewlineOnlyFallsBackToDefault() {
        let env = ["VELLUM_DAEMON_SOCKET": "\n"]
        let path = DaemonClient.resolveSocketPath(environment: env)
        XCTAssertEqual(path, NSHomeDirectory() + "/.vellum/vellum.sock")
    }

    func testNilEnvironmentUsesProcessInfo() {
        // When no environment is passed, it uses ProcessInfo.processInfo.environment.
        // We just verify it returns a non-empty string (the default path).
        let path = DaemonClient.resolveSocketPath()
        XCTAssertFalse(path.isEmpty)
        XCTAssertTrue(path.hasSuffix("vellum.sock"))
    }
}
