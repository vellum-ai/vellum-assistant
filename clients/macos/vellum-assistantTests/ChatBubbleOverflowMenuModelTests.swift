import Testing
import SwiftUI
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - Overflow Menu Decision Logic

/// Tests for the decision logic that drives `ChatBubbleOverflowMenu`.
/// These validate the computed properties (`hasOverflowActions`, `showOverflowMenu`)
/// using a lightweight model struct to avoid constructing full `ChatMessage` instances.

/// Mirror of the overflow menu's decision inputs, decoupled from ChatMessage.
private struct OverflowMenuDecision: Equatable {
    let hasCopyableText: Bool
    let canInspectMessage: Bool
    let canForkFromMessage: Bool
    let isStreaming: Bool
    let isHovered: Bool
    let showCopyConfirmation: Bool
    let audioIsPlaying: Bool
    let audioIsLoading: Bool
    let showTTSSetupPopover: Bool

    var hasOverflowActions: Bool {
        hasCopyableText || canInspectMessage || canForkFromMessage
    }

    var showOverflowMenu: Bool {
        hasOverflowActions && !isStreaming && (isHovered || showCopyConfirmation || audioIsPlaying || audioIsLoading || showTTSSetupPopover)
    }
}

@Suite("ChatBubbleOverflowMenu — hasOverflowActions")
struct OverflowMenuHasActionsTests {

    @Test func trueWhenCopyable() {
        let decision = OverflowMenuDecision(
            hasCopyableText: true, canInspectMessage: false, canForkFromMessage: false,
            isStreaming: false, isHovered: false, showCopyConfirmation: false,
            audioIsPlaying: false, audioIsLoading: false, showTTSSetupPopover: false
        )
        #expect(decision.hasOverflowActions)
    }

    @Test func trueWhenCanInspect() {
        let decision = OverflowMenuDecision(
            hasCopyableText: false, canInspectMessage: true, canForkFromMessage: false,
            isStreaming: false, isHovered: false, showCopyConfirmation: false,
            audioIsPlaying: false, audioIsLoading: false, showTTSSetupPopover: false
        )
        #expect(decision.hasOverflowActions)
    }

    @Test func trueWhenCanFork() {
        let decision = OverflowMenuDecision(
            hasCopyableText: false, canInspectMessage: false, canForkFromMessage: true,
            isStreaming: false, isHovered: false, showCopyConfirmation: false,
            audioIsPlaying: false, audioIsLoading: false, showTTSSetupPopover: false
        )
        #expect(decision.hasOverflowActions)
    }

    @Test func falseWhenNoneAvailable() {
        let decision = OverflowMenuDecision(
            hasCopyableText: false, canInspectMessage: false, canForkFromMessage: false,
            isStreaming: false, isHovered: false, showCopyConfirmation: false,
            audioIsPlaying: false, audioIsLoading: false, showTTSSetupPopover: false
        )
        #expect(!decision.hasOverflowActions)
    }
}

@Suite("ChatBubbleOverflowMenu — showOverflowMenu")
struct OverflowMenuVisibilityTests {

    @Test func shownOnHover() {
        let decision = OverflowMenuDecision(
            hasCopyableText: true, canInspectMessage: false, canForkFromMessage: false,
            isStreaming: false, isHovered: true, showCopyConfirmation: false,
            audioIsPlaying: false, audioIsLoading: false, showTTSSetupPopover: false
        )
        #expect(decision.showOverflowMenu)
    }

    @Test func shownDuringCopyConfirmation() {
        let decision = OverflowMenuDecision(
            hasCopyableText: true, canInspectMessage: false, canForkFromMessage: false,
            isStreaming: false, isHovered: false, showCopyConfirmation: true,
            audioIsPlaying: false, audioIsLoading: false, showTTSSetupPopover: false
        )
        #expect(decision.showOverflowMenu)
    }

    @Test func shownDuringAudioPlayback() {
        let decision = OverflowMenuDecision(
            hasCopyableText: true, canInspectMessage: false, canForkFromMessage: false,
            isStreaming: false, isHovered: false, showCopyConfirmation: false,
            audioIsPlaying: true, audioIsLoading: false, showTTSSetupPopover: false
        )
        #expect(decision.showOverflowMenu)
    }

    @Test func shownDuringAudioLoading() {
        let decision = OverflowMenuDecision(
            hasCopyableText: true, canInspectMessage: false, canForkFromMessage: false,
            isStreaming: false, isHovered: false, showCopyConfirmation: false,
            audioIsPlaying: false, audioIsLoading: true, showTTSSetupPopover: false
        )
        #expect(decision.showOverflowMenu)
    }

    @Test func shownDuringTTSSetupPopover() {
        let decision = OverflowMenuDecision(
            hasCopyableText: true, canInspectMessage: false, canForkFromMessage: false,
            isStreaming: false, isHovered: false, showCopyConfirmation: false,
            audioIsPlaying: false, audioIsLoading: false, showTTSSetupPopover: true
        )
        #expect(decision.showOverflowMenu)
    }

    @Test func hiddenWhenStreaming() {
        let decision = OverflowMenuDecision(
            hasCopyableText: true, canInspectMessage: false, canForkFromMessage: false,
            isStreaming: true, isHovered: true, showCopyConfirmation: false,
            audioIsPlaying: false, audioIsLoading: false, showTTSSetupPopover: false
        )
        #expect(!decision.showOverflowMenu)
    }

    @Test func hiddenWhenNoActions() {
        let decision = OverflowMenuDecision(
            hasCopyableText: false, canInspectMessage: false, canForkFromMessage: false,
            isStreaming: false, isHovered: true, showCopyConfirmation: false,
            audioIsPlaying: false, audioIsLoading: false, showTTSSetupPopover: false
        )
        #expect(!decision.showOverflowMenu)
    }

    @Test func hiddenWhenNoVisibilityTrigger() {
        let decision = OverflowMenuDecision(
            hasCopyableText: true, canInspectMessage: false, canForkFromMessage: false,
            isStreaming: false, isHovered: false, showCopyConfirmation: false,
            audioIsPlaying: false, audioIsLoading: false, showTTSSetupPopover: false
        )
        #expect(!decision.showOverflowMenu)
    }
}
