import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

@MainActor
final class AssistantSwitcherViewModelTests: XCTestCase {
    private var tempDir: URL!
    private var lockfilePath: String!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try! FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        lockfilePath = tempDir.appendingPathComponent(".vellum.lock.json").path
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        tempDir = nil
        lockfilePath = nil
        super.tearDown()
    }

    // MARK: - Filtering

    func testListsOnlyManagedCurrentEnvironmentAssistants() {
        // Seed three managed entries + verify we read them back. Non-managed /
        // wrong-environment filtering relies on `LockfileAssistant` computed
        // properties, which are covered by LockfileAssistantManagedTests —
        // here we exercise the filter predicate on a mocked loader so the
        // test stays pure.
        let managedCurrent = makeAssistant(id: "managed-a", runtimeUrl: "https://platform.example.com")
        let managedOther = makeAssistant(id: "managed-b", runtimeUrl: "https://platform.example.com")
        let unmanaged = makeAssistant(id: "local-a", runtimeUrl: "", isLocal: true)

        let spy = SwitcherSpy()
        let vm = AssistantSwitcherViewModel(
            switchHandler: spy.switchHandler,
            createHandler: spy.createHandler,
            retireHandler: spy.retireHandler,
            lockfileLoader: { [managedCurrent, managedOther, unmanaged] },
            activeIdLoader: { "managed-a" }
        )

        XCTAssertEqual(vm.assistants.map(\.assistantId), ["managed-a", "managed-b"])
        XCTAssertEqual(vm.selectedAssistantId, "managed-a")
    }

    // MARK: - Select

    func testSelectInvokesSwitchHandlerWithCorrectId() async throws {
        let managedA = makeAssistant(id: "managed-a", runtimeUrl: "https://platform.example.com")
        let managedB = makeAssistant(id: "managed-b", runtimeUrl: "https://platform.example.com")

        let spy = SwitcherSpy()
        var activeId = "managed-a"
        let vm = AssistantSwitcherViewModel(
            switchHandler: spy.switchHandler,
            createHandler: spy.createHandler,
            retireHandler: spy.retireHandler,
            lockfileLoader: { [managedA, managedB] },
            activeIdLoader: { activeId }
        )

        // Pretend the switchHandler flipped the active id (as the real
        // coordinator would via LockfileAssistant.setActiveAssistantId).
        spy.onSwitch = { _ in activeId = "managed-b" }

        try await vm.select(assistantId: "managed-b")

        XCTAssertEqual(spy.switchCalls, ["managed-b"])
        XCTAssertEqual(vm.selectedAssistantId, "managed-b",
                       "refresh() should run after select and pick up the new active id")
    }

    func testSelectIsNoOpWhenAlreadyActive() async throws {
        let managedA = makeAssistant(id: "managed-a", runtimeUrl: "https://platform.example.com")
        let spy = SwitcherSpy()
        let vm = AssistantSwitcherViewModel(
            switchHandler: spy.switchHandler,
            createHandler: spy.createHandler,
            retireHandler: spy.retireHandler,
            lockfileLoader: { [managedA] },
            activeIdLoader: { "managed-a" }
        )

        try await vm.select(assistantId: "managed-a")

        XCTAssertTrue(spy.switchCalls.isEmpty,
                      "Selecting the already-active assistant must not drive the switch handler")
    }

    // MARK: - Active change notification

    func testActiveAssistantDidChangeTriggersRefresh() {
        let managedA = makeAssistant(id: "managed-a", runtimeUrl: "https://platform.example.com")
        let managedB = makeAssistant(id: "managed-b", runtimeUrl: "https://platform.example.com")

        let spy = SwitcherSpy()
        var activeId: String? = "managed-a"
        // Use a scoped NotificationCenter to avoid cross-test pollution.
        let center = NotificationCenter()
        let vm = AssistantSwitcherViewModel(
            switchHandler: spy.switchHandler,
            createHandler: spy.createHandler,
            retireHandler: spy.retireHandler,
            lockfileLoader: { [managedA, managedB] },
            activeIdLoader: { activeId },
            notificationCenter: center
        )

        XCTAssertEqual(vm.selectedAssistantId, "managed-a")

        activeId = "managed-b"
        let expectation = self.expectation(description: "refresh after active change")
        center.post(name: LockfileAssistant.activeAssistantDidChange, object: nil)
        // The observer posts to the main queue. Hop through it so we can
        // observe the refresh.
        DispatchQueue.main.async {
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1.0)

        XCTAssertEqual(vm.selectedAssistantId, "managed-b")
    }

    // MARK: - Retire

    func testRetireRemovesAssistantFromListAfterHandlerCompletes() async throws {
        let managedA = makeAssistant(id: "managed-a", runtimeUrl: "https://platform.example.com")
        let managedB = makeAssistant(id: "managed-b", runtimeUrl: "https://platform.example.com")

        var current: [LockfileAssistant] = [managedA, managedB]
        let spy = SwitcherSpy()
        let vm = AssistantSwitcherViewModel(
            switchHandler: spy.switchHandler,
            createHandler: spy.createHandler,
            retireHandler: spy.retireHandler,
            lockfileLoader: { current },
            activeIdLoader: { "managed-a" }
        )

        // Pretend the retire handler removed managed-b from the lockfile.
        spy.onRetire = { id in
            current.removeAll { $0.assistantId == id }
        }

        try await vm.retire(assistantId: "managed-b")

        XCTAssertEqual(spy.retireCalls, ["managed-b"])
        XCTAssertEqual(vm.assistants.map(\.assistantId), ["managed-a"])
    }

    // MARK: - Create

    func testCreateNewAssistantInvokesCreateHandler() async throws {
        let spy = SwitcherSpy()
        let vm = AssistantSwitcherViewModel(
            switchHandler: spy.switchHandler,
            createHandler: spy.createHandler,
            retireHandler: spy.retireHandler,
            lockfileLoader: { [] },
            activeIdLoader: { nil }
        )

        try await vm.createNewAssistant(name: "Zephyr")

        XCTAssertEqual(spy.createCalls, ["Zephyr"])
    }

    // MARK: - Helpers

    /// Construct a minimal `LockfileAssistant` for testing. We round-trip
    /// through `ensureManagedEntry` on a temp file so the resulting value
    /// has `isManaged == true` and `isCurrentEnvironment == true` against
    /// the injected runtime URL.
    private func makeAssistant(
        id: String,
        runtimeUrl: String,
        isLocal: Bool = false
    ) -> LockfileAssistant {
        let dir = tempDir.appendingPathComponent(UUID().uuidString, isDirectory: true).path
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let path = (dir as NSString).appendingPathComponent(".vellum.lock.json")
        if isLocal {
            // Write a local (non-managed) entry directly.
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

@MainActor
private final class SwitcherSpy {
    var switchCalls: [String] = []
    var createCalls: [String] = []
    var retireCalls: [String] = []

    var onSwitch: ((String) -> Void)?
    var onCreate: ((String) -> Void)?
    var onRetire: ((String) -> Void)?

    lazy var switchHandler: @MainActor (String) async throws -> Void = { [weak self] id in
        self?.switchCalls.append(id)
        self?.onSwitch?(id)
    }
    lazy var createHandler: @MainActor (String) async throws -> Void = { [weak self] name in
        self?.createCalls.append(name)
        self?.onCreate?(name)
    }
    lazy var retireHandler: @MainActor (String) async throws -> Void = { [weak self] id in
        self?.retireCalls.append(id)
        self?.onRetire?(id)
    }
}
