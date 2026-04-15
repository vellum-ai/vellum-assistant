import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

/// Regression tests for LUM-755.
///
/// Original issue: when the CLI retire of a managed (cloud-hosted) assistant
/// fails, showing the Force Remove / Cancel alert and reconnecting on Cancel
/// strands the user on an unreachable / permanently-loading screen because
/// the cloud instance may already be partially torn down.
///
/// Fix (PR #24317, April 2026): managed retire failures auto-clean local
/// state and find a replacement — no alert, no reconnect.
///
/// Regression (PRs #24927 + #24959, April 2026): a refactor collapsed the
/// managed-specific branch; #24927's own checklist flagged the risk but the
/// PR merged without the behavior preserved and without a test to catch it.
///
/// These tests lock the invariant in place. Any future refactor that
/// collapses or removes ``AssistantManagementClient.retireFailurePolicy(for:)``
/// will trip these tests rather than silently ship the regression a third
/// time.
@MainActor
final class RetireFailurePolicyTests: XCTestCase {
    private var tempDir: URL!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try! FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        tempDir = nil
        super.tearDown()
    }

    // MARK: - LUM-755 invariant

    func testLUM755_managedRetireFailureAutoCleansWithoutAlert() {
        let managed = makeAssistant(id: "managed-a", runtimeUrl: "https://platform.example.com")

        let policy = AssistantManagementClient.retireFailurePolicy(for: managed)

        XCTAssertEqual(
            policy,
            .autoCleanAndFindReplacement,
            "LUM-755: managed retire failures must auto-clean local state. Showing the Force Remove / Cancel alert reconnects to a possibly dead cloud instance and strands the user on an unreachable / permanently-loading screen."
        )
    }

    func testLocalRetireFailurePromptsForceRemoveOrCancel() {
        let local = makeAssistant(id: "local-a", runtimeUrl: "", isLocal: true)

        let policy = AssistantManagementClient.retireFailurePolicy(for: local)

        XCTAssertEqual(
            policy,
            .rethrow,
            "Local retire failures must re-throw so the caller can show the Force Remove / Cancel alert — the daemon may still be running and the user must decide."
        )
    }

    func testNilAssistantRetireFailureFallsThroughToAlert() {
        // Defensive: an unknown/missing assistant should not silently
        // auto-clean (there's nothing safe to clean) — re-throw and let
        // the caller surface the error.
        let policy = AssistantManagementClient.retireFailurePolicy(for: nil)

        XCTAssertEqual(policy, .rethrow)
    }

    // MARK: - Helpers

    /// Construct a minimal `LockfileAssistant` for testing. Mirrors the
    /// helper in `AssistantSwitcherViewModelTests`.
    private func makeAssistant(
        id: String,
        runtimeUrl: String,
        isLocal: Bool = false
    ) -> LockfileAssistant {
        let dir = tempDir.appendingPathComponent(UUID().uuidString, isDirectory: true).path
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let path = (dir as NSString).appendingPathComponent(".vellum.lock.json")
        if isLocal {
            let json: [String: Any] = [
                "activeAssistant": id,
                "assistants": [
                    id: [
                        "createdAt": "2024-01-01T00:00:00Z",
                        "instanceDir": dir,
                    ]
                ]
            ]
            let data = try! JSONSerialization.data(withJSONObject: json)
            try! data.write(to: URL(fileURLWithPath: path))
        } else {
            LockfileAssistant.ensureManagedEntry(
                assistantId: id,
                runtimeUrl: runtimeUrl,
                hatchedAt: "2024-01-01T00:00:00Z",
                lockfilePath: path
            )
        }
        return LockfileAssistant.loadByName(id, lockfilePath: path)!
    }
}
