import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class AssistantFeatureFlagResolverTests: XCTestCase {
    private let conversationStartersKey = "feature_flags.conversation-starters.enabled"

    private func makeRegistry(defaultEnabled: Bool) -> FeatureFlagRegistry {
        FeatureFlagRegistry(
            version: 1,
            flags: [
                FeatureFlagDefinition(
                    id: "conversation-starters",
                    scope: .assistant,
                    key: conversationStartersKey,
                    label: "Recommended Starts",
                    description: "Show conversation starter chips",
                    defaultEnabled: defaultEnabled
                )
            ]
        )
    }

    func testUsesAssistantRegistryDefaultWhenNoOverrideExists() {
        let enabled = AssistantFeatureFlagResolver.isEnabled(
            conversationStartersKey,
            config: [:],
            registry: makeRegistry(defaultEnabled: false)
        )

        XCTAssertFalse(enabled)
    }

    func testPersistedAssistantOverrideWinsOverRegistryDefault() {
        let enabled = AssistantFeatureFlagResolver.isEnabled(
            conversationStartersKey,
            config: [
                "assistantFeatureFlagValues": [
                    conversationStartersKey: true
                ]
            ],
            registry: makeRegistry(defaultEnabled: false)
        )

        XCTAssertTrue(enabled)
    }

    func testUndeclaredAssistantFlagsDefaultToEnabled() {
        let enabled = AssistantFeatureFlagResolver.isEnabled(
            "feature_flags.unknown.enabled",
            config: [:],
            registry: makeRegistry(defaultEnabled: false)
        )

        XCTAssertTrue(enabled)
    }

    @MainActor
    func testStoreCachesResolvedFlagsAfterInitialLoad() async {
        let mockClient = MockSettingsClient()
        mockClient.fetchConfigResponse = [:]
        let store = AssistantFeatureFlagStore(
            notificationCenter: NotificationCenter(),
            registry: makeRegistry(defaultEnabled: false),
            settingsClient: mockClient
        )

        // Wait for the init Task to finish fetching from daemon.
        await store.reloadFromDaemon()

        XCTAssertFalse(store.isEnabled(conversationStartersKey))
        XCTAssertFalse(store.isEnabled(conversationStartersKey))
    }

    @MainActor
    func testStoreAppliesFlagChangeNotificationsWithoutReloadingConfig() async {
        let notificationCenter = NotificationCenter()
        let mockClient = MockSettingsClient()
        mockClient.fetchConfigResponse = [:]
        let store = AssistantFeatureFlagStore(
            notificationCenter: notificationCenter,
            registry: makeRegistry(defaultEnabled: false),
            settingsClient: mockClient
        )

        // Wait for the init Task to finish so it doesn't race with the notification.
        await store.reloadFromDaemon()
        let callCountBeforeNotification = mockClient.fetchConfigCallCount

        notificationCenter.post(
            name: .assistantFeatureFlagDidChange,
            object: nil,
            userInfo: ["key": conversationStartersKey, "enabled": true]
        )
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))

        XCTAssertTrue(store.isEnabled(conversationStartersKey))
        // The targeted notification should not trigger a daemon fetch.
        XCTAssertEqual(mockClient.fetchConfigCallCount, callCountBeforeNotification)
    }
}
