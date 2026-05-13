import Testing
import SwiftUI
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - ChatButtonConfig Equality

@Suite("ChatButtonConfig — Equality semantics")
struct ChatButtonConfigEqualityTests {

    private static let baseConfig = ChatButtonConfig(
        label: "Copy message",
        iconOnly: VIcon.copy.rawValue,
        style: .ghost,
        size: .regular,
        iconSize: 24,
        iconColorRole: .contentTertiary,
        tooltip: nil,
        isDisabled: false
    )

    @Test func identicalConfigsAreEqual() {
        let a = Self.baseConfig
        let b = Self.baseConfig
        #expect(a == b)
    }

    @Test func differentLabelMakesUnequal() {
        let a = Self.baseConfig
        let b = ChatButtonConfig(
            label: "Copied",
            iconOnly: VIcon.copy.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: 24,
            iconColorRole: .contentTertiary,
            tooltip: nil,
            isDisabled: false
        )
        #expect(a != b)
    }

    @Test func differentIconMakesUnequal() {
        let a = Self.baseConfig
        let b = ChatButtonConfig(
            label: "Copy message",
            iconOnly: VIcon.check.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: 24,
            iconColorRole: .contentTertiary,
            tooltip: nil,
            isDisabled: false
        )
        #expect(a != b)
    }

    @Test func differentColorRoleMakesUnequal() {
        let a = Self.baseConfig
        let b = ChatButtonConfig(
            label: "Copy message",
            iconOnly: VIcon.copy.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: 24,
            iconColorRole: .systemPositiveStrong,
            tooltip: nil,
            isDisabled: false
        )
        #expect(a != b)
    }

    @Test func differentStyleMakesUnequal() {
        let a = Self.baseConfig
        let b = ChatButtonConfig(
            label: "Copy message",
            iconOnly: VIcon.copy.rawValue,
            style: .primary,
            size: .regular,
            iconSize: 24,
            iconColorRole: .contentTertiary,
            tooltip: nil,
            isDisabled: false
        )
        #expect(a != b)
    }

    @Test func differentSizeMakesUnequal() {
        let a = Self.baseConfig
        let b = ChatButtonConfig(
            label: "Copy message",
            iconOnly: VIcon.copy.rawValue,
            style: .ghost,
            size: .inline,
            iconSize: 24,
            iconColorRole: .contentTertiary,
            tooltip: nil,
            isDisabled: false
        )
        #expect(a != b)
    }

    @Test func differentIconSizeMakesUnequal() {
        let a = Self.baseConfig
        let b = ChatButtonConfig(
            label: "Copy message",
            iconOnly: VIcon.copy.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: 16,
            iconColorRole: .contentTertiary,
            tooltip: nil,
            isDisabled: false
        )
        #expect(a != b)
    }

    @Test func nilVsNonNilIconSizeMakesUnequal() {
        let a = Self.baseConfig
        let b = ChatButtonConfig(
            label: "Copy message",
            iconOnly: VIcon.copy.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: nil,
            iconColorRole: .contentTertiary,
            tooltip: nil,
            isDisabled: false
        )
        #expect(a != b)
    }

    @Test func differentDisabledStateMakesUnequal() {
        let a = Self.baseConfig
        let b = ChatButtonConfig(
            label: "Copy message",
            iconOnly: VIcon.copy.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: 24,
            iconColorRole: .contentTertiary,
            tooltip: nil,
            isDisabled: true
        )
        #expect(a != b)
    }

    @Test func differentTooltipMakesUnequal() {
        let a = Self.baseConfig
        let b = ChatButtonConfig(
            label: "Copy message",
            iconOnly: VIcon.copy.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: 24,
            iconColorRole: .contentTertiary,
            tooltip: "Copy",
            isDisabled: false
        )
        #expect(a != b)
    }
}

// MARK: - ChatButtonColorRole

@Suite("ChatButtonColorRole — Token resolution")
struct ChatButtonColorRoleTests {

    @Test func contentTertiaryResolvesCorrectly() {
        #expect(ChatButtonColorRole.contentTertiary.resolved == VColor.contentTertiary)
    }

    @Test func systemPositiveStrongResolvesCorrectly() {
        #expect(ChatButtonColorRole.systemPositiveStrong.resolved == VColor.systemPositiveStrong)
    }

    @Test func systemNegativeStrongResolvesCorrectly() {
        #expect(ChatButtonColorRole.systemNegativeStrong.resolved == VColor.systemNegativeStrong)
    }

    @Test func primaryBaseResolvesCorrectly() {
        #expect(ChatButtonColorRole.primaryBase.resolved == VColor.primaryBase)
    }
}

// MARK: - ChatEquatableButton Equality

@Suite("ChatEquatableButton — Closure-agnostic equality")
struct ChatEquatableButtonEqualityTests {

    @Test func sameConfigDifferentClosuresAreEqual() {
        let a = ChatEquatableButton(label: "Copy", iconOnly: VIcon.copy.rawValue) { }
        let b = ChatEquatableButton(label: "Copy", iconOnly: VIcon.copy.rawValue) { print("different") }
        #expect(a == b)
    }

    @Test func differentConfigSameClosureAreUnequal() {
        let closure: () -> Void = {}
        let a = ChatEquatableButton(label: "Copy", iconOnly: VIcon.copy.rawValue, action: closure)
        let b = ChatEquatableButton(
            label: "Copied",
            iconOnly: VIcon.check.rawValue,
            iconColorRole: .systemPositiveStrong,
            action: closure
        )
        #expect(a != b)
    }
}

// MARK: - Copy Button Toggle

@Suite("ChatButtonConfig — Copy button state transitions")
struct CopyButtonConfigTests {

    @Test func idleAndConfirmedConfigsAreUnequal() {
        let idle = ChatButtonConfig(
            label: "Copy message",
            iconOnly: VIcon.copy.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: 24,
            iconColorRole: .contentTertiary,
            tooltip: nil,
            isDisabled: false
        )
        let confirmed = ChatButtonConfig(
            label: "Copied",
            iconOnly: VIcon.check.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: 24,
            iconColorRole: .systemPositiveStrong,
            tooltip: nil,
            isDisabled: false
        )
        #expect(idle != confirmed)
    }
}

// MARK: - Retry Button Config (PR 3)

@Suite("ChatButtonConfig — Retry button stability")
struct RetryButtonConfigTests {

    @Test func retryConfigIsStatic() {
        let a = ChatButtonConfig(
            label: "Retry",
            iconOnly: nil,
            style: .ghost,
            size: .inline,
            iconSize: nil,
            iconColorRole: nil,
            tooltip: nil,
            isDisabled: false
        )
        let b = ChatButtonConfig(
            label: "Retry",
            iconOnly: nil,
            style: .ghost,
            size: .inline,
            iconSize: nil,
            iconColorRole: nil,
            tooltip: nil,
            isDisabled: false
        )
        #expect(a == b)
    }
}

// MARK: - Output Copy Label Variation (PR 3)

@Suite("ChatButtonConfig — Output copy label variation")
struct OutputCopyConfigTests {

    @Test func differentCopyLabelsMakeUnequal() {
        let live = ChatButtonConfig(
            label: "Copy live output",
            iconOnly: VIcon.copy.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: 24,
            iconColorRole: .contentTertiary,
            tooltip: nil,
            isDisabled: false
        )
        let done = ChatButtonConfig(
            label: "Copy output",
            iconOnly: VIcon.copy.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: 24,
            iconColorRole: .contentTertiary,
            tooltip: nil,
            isDisabled: false
        )
        #expect(live != done)
    }

    @Test func sameCopyLabelIsStable() {
        let a = ChatButtonConfig(
            label: "Copy output",
            iconOnly: VIcon.copy.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: 24,
            iconColorRole: .contentTertiary,
            tooltip: nil,
            isDisabled: false
        )
        let b = ChatButtonConfig(
            label: "Copy output",
            iconOnly: VIcon.copy.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: 24,
            iconColorRole: .contentTertiary,
            tooltip: nil,
            isDisabled: false
        )
        #expect(a == b)
    }

    @Test func differentClosureIdentityForcesReevaluation() {
        let a = ChatButtonConfig(
            label: "Copy live output",
            iconOnly: VIcon.copy.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: 24,
            iconColorRole: .contentTertiary,
            tooltip: nil,
            isDisabled: false,
            closureIdentity: "partial output".hashValue
        )
        let b = ChatButtonConfig(
            label: "Copy live output",
            iconOnly: VIcon.copy.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: 24,
            iconColorRole: .contentTertiary,
            tooltip: nil,
            isDisabled: false,
            closureIdentity: "partial output extended".hashValue
        )
        #expect(a != b)
    }

    @Test func sameClosureIdentityStaysEqual() {
        let text = "some output"
        let a = ChatButtonConfig(
            label: "Copy live output",
            iconOnly: VIcon.copy.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: 24,
            iconColorRole: .contentTertiary,
            tooltip: nil,
            isDisabled: false,
            closureIdentity: text.hashValue
        )
        let b = ChatButtonConfig(
            label: "Copy live output",
            iconOnly: VIcon.copy.rawValue,
            style: .ghost,
            size: .regular,
            iconSize: 24,
            iconColorRole: .contentTertiary,
            tooltip: nil,
            isDisabled: false,
            closureIdentity: text.hashValue
        )
        #expect(a == b)
    }
}
