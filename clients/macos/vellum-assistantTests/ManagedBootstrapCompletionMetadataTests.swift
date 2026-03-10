import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ManagedBootstrapCompletionMetadataTests: XCTestCase {
    func testCreatedNewAssistantTriggersWakeUpGreeting() {
        let assistant = PlatformAssistant(
            id: "assistant-new",
            created_at: "2024-01-02T03:04:05Z"
        )

        let result = deriveManagedBootstrapCompletionMetadata(
            outcome: .createdNew(assistant),
            existingHatchedAt: "2023-12-01T00:00:00Z"
        )

        XCTAssertTrue(result.shouldSendWakeUpGreeting)
        XCTAssertEqual(result.hatchedAt, "2024-01-02T03:04:05Z")
    }

    func testReusedExistingAssistantSkipsWakeUpGreetingAndPreservesLockfileTimestamp() {
        let assistant = PlatformAssistant(
            id: "assistant-existing",
            created_at: "2024-01-02T03:04:05Z"
        )

        let result = deriveManagedBootstrapCompletionMetadata(
            outcome: .reusedExisting(assistant),
            existingHatchedAt: "2023-12-01T00:00:00Z"
        )

        XCTAssertFalse(result.shouldSendWakeUpGreeting)
        XCTAssertEqual(result.hatchedAt, "2023-12-01T00:00:00Z")
    }

    func testReusedExistingAssistantFallsBackToPlatformCreatedAtWhenLockfileMissing() {
        let assistant = PlatformAssistant(
            id: "assistant-existing",
            created_at: "2024-01-02T03:04:05Z"
        )

        let result = deriveManagedBootstrapCompletionMetadata(
            outcome: .reusedExisting(assistant),
            existingHatchedAt: nil
        )

        XCTAssertFalse(result.shouldSendWakeUpGreeting)
        XCTAssertEqual(result.hatchedAt, "2024-01-02T03:04:05Z")
    }

    func testFallsBackToCurrentDateWhenNoTimestampExists() {
        let assistant = PlatformAssistant(id: "assistant-no-date")
        let fallbackDate = Date(timeIntervalSince1970: 1_704_153_600)

        let result = deriveManagedBootstrapCompletionMetadata(
            outcome: .reusedExisting(assistant),
            existingHatchedAt: nil,
            fallbackDate: fallbackDate
        )

        XCTAssertFalse(result.shouldSendWakeUpGreeting)
        XCTAssertEqual(result.hatchedAt, "2024-01-02T00:00:00.000Z")
    }
}
