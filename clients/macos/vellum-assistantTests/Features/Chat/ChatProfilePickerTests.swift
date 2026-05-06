import SwiftUI
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ChatProfilePickerTests: XCTestCase {

    // MARK: - Label

    func testLabelShowsDefaultWhenOverrideIsNil() {
        let profiles = [InferenceProfile(name: "balanced")]
        XCTAssertEqual(
            ChatProfilePicker.label(current: nil, profiles: profiles, activeProfile: "balanced"),
            "Default (balanced)"
        )
    }

    func testLabelShowsProfileNameWhenOverrideIsSet() {
        let profiles = [
            InferenceProfile(name: "quality-optimized"),
            InferenceProfile(name: "balanced"),
        ]
        XCTAssertEqual(
            ChatProfilePicker.label(current: "quality-optimized", profiles: profiles, activeProfile: "balanced"),
            "quality-optimized"
        )
    }

    func testLabelReflectsActiveProfileChange() {
        let profiles = [InferenceProfile(name: "cost-optimized")]
        XCTAssertEqual(
            ChatProfilePicker.label(current: nil, profiles: profiles, activeProfile: "cost-optimized"),
            "Default (cost-optimized)"
        )
    }

    func testLabelShowsDisplayNameWhenLabelIsSet() {
        let profiles = [
            InferenceProfile(name: "quality-optimized", label: "Quality"),
            InferenceProfile(name: "balanced", label: "Balanced"),
        ]
        XCTAssertEqual(
            ChatProfilePicker.label(current: "quality-optimized", profiles: profiles, activeProfile: "balanced"),
            "Quality"
        )
        XCTAssertEqual(
            ChatProfilePicker.label(current: nil, profiles: profiles, activeProfile: "balanced"),
            "Default (Balanced)"
        )
    }

    // MARK: - Create profile command

    func testConfigurationDefaultsHideCreateProfileCommand() {
        let config = ChatProfilePickerConfiguration(
            current: nil,
            profiles: [],
            activeProfile: "balanced",
            onSelect: { _ in }
        )

        XCTAssertFalse(config.canCreateProfile)
        XCTAssertNil(config.onCreateProfile)
        XCTAssertFalse(ComposerSettingsMenu.shouldRenderProfileSection(for: config))
        XCTAssertFalse(ComposerSettingsMenu.shouldExposeCreateProfileCommand(for: config))
    }

    func testCreateProfileCommandIsExposedWhenEnabledWithoutProfiles() {
        var didRequestCreateProfile = false
        let config = ChatProfilePickerConfiguration(
            current: nil,
            profiles: [],
            activeProfile: "balanced",
            canCreateProfile: true,
            onSelect: { _ in },
            onCreateProfile: {
                didRequestCreateProfile = true
            }
        )

        XCTAssertTrue(config.canCreateProfile)
        XCTAssertTrue(ComposerSettingsMenu.shouldRenderProfileSection(for: config))
        XCTAssertTrue(ComposerSettingsMenu.shouldExposeCreateProfileCommand(for: config))

        config.onCreateProfile?()

        XCTAssertTrue(didRequestCreateProfile)
    }

    func testCreateProfileCommandIsHiddenWhenDisabledWithProfiles() {
        let config = ChatProfilePickerConfiguration(
            current: nil,
            profiles: [InferenceProfile(name: "balanced")],
            activeProfile: "balanced",
            canCreateProfile: false,
            onSelect: { _ in },
            onCreateProfile: {
                XCTFail("Disabled create-profile commands must not be exposed")
            }
        )

        XCTAssertTrue(ComposerSettingsMenu.shouldRenderProfileSection(for: config))
        XCTAssertFalse(ComposerSettingsMenu.shouldExposeCreateProfileCommand(for: config))
    }

    func testCreateProfileCommandIsHiddenWhenCallbackIsMissing() {
        let config = ChatProfilePickerConfiguration(
            current: nil,
            profiles: [],
            activeProfile: "balanced",
            canCreateProfile: true,
            onSelect: { _ in }
        )

        XCTAssertFalse(ComposerSettingsMenu.shouldRenderProfileSection(for: config))
        XCTAssertFalse(ComposerSettingsMenu.shouldExposeCreateProfileCommand(for: config))
    }

    // MARK: - Selection callback wiring (covers ComposerView → ChatProfilePicker → ConversationManager)

    func testConversationManagerSetsOverrideOnSelection() async {
        let env = makeManagerEnvironment(initialProfile: nil)
        env.mockClient.setResponse = ConversationInferenceProfileResponse(
            conversationId: "conv-1",
            profile: "quality-optimized"
        )

        let picker = makePicker(
            conversationId: env.localId,
            current: nil,
            profiles: env.profiles,
            activeProfile: "balanced",
            manager: env.manager
        )

        picker.onSelect("quality-optimized")
        await env.drainPendingTasks()

        XCTAssertEqual(
            env.mockClient.setCalls,
            [MockChatProfilePickerClient.SetCall(conversationId: "conv-1", profile: "quality-optimized")]
        )
        XCTAssertEqual(env.manager.conversations[0].inferenceProfile, "quality-optimized")
    }

    func testResetToDefaultClearsOverride() async {
        let env = makeManagerEnvironment(initialProfile: "balanced")
        env.mockClient.setResponse = ConversationInferenceProfileResponse(
            conversationId: "conv-1",
            profile: nil
        )

        let picker = makePicker(
            conversationId: env.localId,
            current: "balanced",
            profiles: env.profiles,
            activeProfile: "balanced",
            manager: env.manager
        )

        picker.onSelect(nil)
        await env.drainPendingTasks()

        XCTAssertEqual(
            env.mockClient.setCalls,
            [MockChatProfilePickerClient.SetCall(conversationId: "conv-1", profile: nil)]
        )
        XCTAssertNil(env.manager.conversations[0].inferenceProfile)
    }

    func testCreatedProfileSaveSelectsConversationOverrideWithoutChangingActiveProfile() async {
        let fixture = SettingsTestFixture.make()
        fixture.store.loadInferenceProfiles(config: [
            "llm": [
                "activeProfile": "balanced",
                "profiles": [
                    "balanced": ["provider": "anthropic", "model": "claude-sonnet-4-6"],
                    "custom-profile": ["provider": "openai", "model": "gpt-5"],
                ],
            ]
        ])
        let env = makeManagerEnvironment(initialProfile: nil)
        env.mockClient.setResponse = ConversationInferenceProfileResponse(
            conversationId: "conv-1",
            profile: "custom-profile"
        )

        let onCreatedProfileSaved: (String) -> Void = { savedName in
            Task { @MainActor in
                await env.manager.setConversationInferenceProfile(
                    id: env.localId,
                    profile: savedName
                )
            }
        }

        onCreatedProfileSaved("custom-profile")
        await env.drainPendingTasks()

        XCTAssertEqual(
            env.mockClient.setCalls,
            [MockChatProfilePickerClient.SetCall(conversationId: "conv-1", profile: "custom-profile")]
        )
        XCTAssertEqual(env.manager.conversations[0].inferenceProfile, "custom-profile")
        XCTAssertEqual(fixture.store.activeProfile, "balanced")
        XCTAssertFalse(
            fixture.mockClient.patchConfigCalls.contains { payload in
                guard let llm = payload["llm"] as? [String: Any] else { return false }
                return llm.keys.contains("activeProfile")
            },
            "Chat-owned create-profile save must not patch llm.activeProfile"
        )
    }

    // MARK: - Helpers

    private struct ManagerEnvironment {
        let localId: UUID
        let manager: ConversationManager
        let mockClient: MockChatProfilePickerClient
        let profiles: [InferenceProfile]
        let drainPendingTasks: () async -> Void
    }

    private func makeManagerEnvironment(initialProfile: String?) -> ManagerEnvironment {
        let connectionManager = GatewayConnectionManager()
        connectionManager.isConnected = true
        let mock = MockChatProfilePickerClient()
        let manager = ConversationManager(
            connectionManager: connectionManager,
            eventStreamClient: connectionManager.eventStreamClient,
            conversationInferenceProfileClient: mock
        )
        let localId = UUID()
        manager.conversations = [
            ConversationModel(
                id: localId,
                title: "Picker target",
                conversationId: "conv-1",
                inferenceProfile: initialProfile
            )
        ]
        let profiles: [InferenceProfile] = [
            InferenceProfile(name: "balanced"),
            InferenceProfile(name: "quality-optimized"),
            InferenceProfile(name: "cost-optimized"),
        ]
        return ManagerEnvironment(
            localId: localId,
            manager: manager,
            mockClient: mock,
            profiles: profiles,
            drainPendingTasks: {
                // The picker hands selection to a Task; drain a few main-queue
                // turns so the manager's async setter completes before we
                // assert against its observed state.
                for _ in 0..<10 {
                    try? await Task.sleep(nanoseconds: 5_000_000)
                    if !mock.setCalls.isEmpty { return }
                }
            }
        )
    }

    /// Mirrors the `onSelect` closure the composer wires up: dispatches into
    /// `ConversationManager.setConversationInferenceProfile`. Using the same
    /// closure shape under test pins the integration contract end-to-end.
    private func makePicker(
        conversationId: UUID,
        current: String?,
        profiles: [InferenceProfile],
        activeProfile: String,
        manager: ConversationManager
    ) -> ChatProfilePicker {
        ChatProfilePicker(
            isEnabled: true,
            current: current,
            profiles: profiles,
            activeProfile: activeProfile,
            onSelect: { selection in
                Task { @MainActor in
                    await manager.setConversationInferenceProfile(
                        id: conversationId,
                        profile: selection
                    )
                }
            }
        )
    }
}

private final class MockChatProfilePickerClient: ConversationInferenceProfileClientProtocol {
    struct SetCall: Equatable {
        let conversationId: String
        let profile: String?
    }

    var setResponse: ConversationInferenceProfileResponse?
    private(set) var setCalls: [SetCall] = []

    func setConversationInferenceProfile(
        conversationId: String,
        profile: String?
    ) async -> ConversationInferenceProfileResponse? {
        setCalls.append(SetCall(conversationId: conversationId, profile: profile))
        return setResponse
    }
}
