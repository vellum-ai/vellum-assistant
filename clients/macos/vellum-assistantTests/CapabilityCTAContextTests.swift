import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class CapabilityCTAContextTests: XCTestCase {
    private func makeCapability(
        id: String,
        name: String,
        tier: Capability.Tier,
        ctaLabel: String? = nil,
        unlockHint: String? = nil
    ) -> Capability {
        Capability(
            id: id,
            name: name,
            description: "test description",
            tier: tier,
            gate: "test gate",
            unlockHint: unlockHint,
            ctaLabel: ctaLabel
        )
    }

    func testPrimaryUsesCtaLabelWhenPresent() {
        let cap = makeCapability(id: "email", name: "Email access", tier: .nextUp, ctaLabel: "Connect Google →")
        let msg = CapabilityCTAContext.setupSeedMessage(for: cap, kind: .primary)
        XCTAssertTrue(msg.contains("Connect Google →"))
        XCTAssertTrue(msg.contains("Email access"))
        XCTAssertTrue(msg.contains("Skip preamble"))
    }

    func testPrimaryFallsBackToCapabilityNameWhenNoCtaLabel() {
        let cap = makeCapability(id: "calendar", name: "Calendar awareness", tier: .nextUp, ctaLabel: nil)
        let msg = CapabilityCTAContext.setupSeedMessage(for: cap, kind: .primary)
        XCTAssertTrue(msg.contains("Calendar awareness"))
        XCTAssertFalse(msg.contains("nil"))
    }

    func testShortcutMentionsHonestEffort() {
        let cap = makeCapability(id: "voice-writing", name: "Write in your voice", tier: .earned)
        let msg = CapabilityCTAContext.setupSeedMessage(for: cap, kind: .shortcut)
        XCTAssertTrue(msg.contains("Write in your voice"))
        XCTAssertTrue(msg.contains("not a 1-minute thing") || msg.contains("honest"))
    }

    func testSeedMessageCoversAllSixCapabilities() {
        let next: [Capability] = [
            makeCapability(id: "email",    name: "Email access",       tier: .nextUp, ctaLabel: "Connect Google →"),
            makeCapability(id: "calendar", name: "Calendar awareness", tier: .nextUp, ctaLabel: "Connect Calendar →"),
            makeCapability(id: "slack",    name: "Slack monitoring",   tier: .nextUp, ctaLabel: "Set up Slack →"),
        ]
        for cap in next {
            let msg = CapabilityCTAContext.setupSeedMessage(for: cap, kind: .primary)
            XCTAssertFalse(msg.isEmpty)
        }
        let earned: [Capability] = [
            makeCapability(id: "voice-writing", name: "Write in your voice", tier: .earned),
            makeCapability(id: "proactive",     name: "Proactive suggestions", tier: .earned),
            makeCapability(id: "autonomous",    name: "Act on your behalf", tier: .earned),
        ]
        for cap in earned {
            let msg = CapabilityCTAContext.setupSeedMessage(for: cap, kind: .shortcut)
            XCTAssertFalse(msg.isEmpty)
        }
    }
}
