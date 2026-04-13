import Foundation
import VellumAssistantShared

/// Which CTA the user tapped on the Home page. Determines the shape of the
/// seed message we pre-fill into a new conversation so the assistant knows
/// how to frame the setup flow.
public enum CapabilityCTAKind {
    /// Next-up tier — integration-gated. The user tapped the primary CTA
    /// label (e.g. "Connect Google →") because they want to unlock this
    /// capability right now.
    case primary

    /// Earned tier — the capability is already within reach, but the user
    /// wants to accelerate the path to flip it to unlocked.
    case shortcut
}

/// Pure helper that builds the seed message sent as the first user turn
/// when a Home-page capability CTA opens a new conversation. No SwiftUI,
/// no state, no side effects — just string assembly — so it can be unit
/// tested directly.
public enum CapabilityCTAContext {
    /// Build the seed message to pre-fill into a new conversation when the
    /// user taps a capability CTA on the Home page. The message is written
    /// from the user's voice (third-person "the user") so the assistant
    /// understands the context without treating it as a direct request.
    public static func setupSeedMessage(for capability: Capability, kind: CapabilityCTAKind) -> String {
        switch kind {
        case .primary:
            let label = capability.ctaLabel ?? capability.name
            return "The user tapped '\(label)' from the Home page to set up \(capability.name). Skip preamble and guide them through the setup. Be efficient — they came from a CTA, they want this."
        case .shortcut:
            return "The user wants to accelerate unlocking \(capability.name) — the capability is currently earned-tier. Guide them through a conversation designed to gather enough signal to flip it to unlocked. Be honest about the effort involved (not a 1-minute thing)."
        }
    }
}
