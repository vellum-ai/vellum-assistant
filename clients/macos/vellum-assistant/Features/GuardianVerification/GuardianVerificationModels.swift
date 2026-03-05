import Foundation

// MARK: - Guardian Channel State

/// Bundles all per-channel guardian verification state into a single value type.
/// This replaces the giant switch-statement blocks in SettingsChannelsTab.guardianStatusRow
/// by providing a single struct that can be built from SettingsStore's @Published properties.
struct GuardianChannelState {
    let channel: String
    let identity: String?
    let username: String?
    let displayName: String?
    let verified: Bool
    let inProgress: Bool
    let instruction: String?
    let error: String?
    let alreadyBound: Bool
    let outboundSessionId: String?
    let outboundExpiresAt: Date?
    let outboundNextResendAt: Date?
    let outboundSendCount: Int
    let outboundCode: String?
    let bootstrapUrl: String?

    /// The most user-friendly display name for this guardian.
    /// For telegram/slack: prefers @username, falls back to display name, then raw identity.
    /// For sms/voice: prefers display name, falls back to identity.
    var primaryIdentity: String? {
        if channel == "telegram" || channel == "slack" {
            if let username = username?.trimmingCharacters(in: .whitespacesAndNewlines),
               !username.isEmpty {
                return username.hasPrefix("@") ? username : "@\(username)"
            }
            if let displayName = displayName?.trimmingCharacters(in: .whitespacesAndNewlines),
               !displayName.isEmpty {
                return displayName
            }
        } else if channel == "sms" || channel == "voice" {
            if let displayName = displayName?.trimmingCharacters(in: .whitespacesAndNewlines),
               !displayName.isEmpty {
                return displayName
            }
        }
        return identity
    }

    /// A secondary identifier shown when it differs from the primary.
    /// Returns "ID: <identity>" when the raw identity is distinct from primaryIdentity.
    func secondaryIdentity(primary: String?) -> String? {
        guard let identity = identity?.trimmingCharacters(in: .whitespacesAndNewlines),
              !identity.isEmpty else {
            return nil
        }
        if let primary {
            let normalizedPrimary = primary.trimmingCharacters(in: .whitespacesAndNewlines)
            if normalizedPrimary.caseInsensitiveCompare(identity) == .orderedSame {
                return nil
            }
        }
        return "ID: \(identity)"
    }
}

// MARK: - SettingsStore Extension

@MainActor
extension SettingsStore {
    /// Reads all per-channel @Published guardian properties and returns them as a single struct.
    func guardianChannelState(for channel: String) -> GuardianChannelState {
        switch channel {
        case "telegram":
            return GuardianChannelState(
                channel: channel,
                identity: telegramGuardianIdentity,
                username: telegramGuardianUsername,
                displayName: telegramGuardianDisplayName,
                verified: telegramGuardianVerified,
                inProgress: telegramGuardianVerificationInProgress,
                instruction: telegramGuardianInstruction,
                error: telegramGuardianError,
                alreadyBound: telegramGuardianAlreadyBound,
                outboundSessionId: telegramOutboundSessionId,
                outboundExpiresAt: telegramOutboundExpiresAt,
                outboundNextResendAt: telegramOutboundNextResendAt,
                outboundSendCount: telegramOutboundSendCount,
                outboundCode: telegramOutboundCode,
                bootstrapUrl: telegramBootstrapUrl
            )
        case "sms":
            return GuardianChannelState(
                channel: channel,
                identity: smsGuardianIdentity,
                username: smsGuardianUsername,
                displayName: smsGuardianDisplayName,
                verified: smsGuardianVerified,
                inProgress: smsGuardianVerificationInProgress,
                instruction: smsGuardianInstruction,
                error: smsGuardianError,
                alreadyBound: smsGuardianAlreadyBound,
                outboundSessionId: smsOutboundSessionId,
                outboundExpiresAt: smsOutboundExpiresAt,
                outboundNextResendAt: smsOutboundNextResendAt,
                outboundSendCount: smsOutboundSendCount,
                outboundCode: smsOutboundCode,
                bootstrapUrl: nil
            )
        case "voice":
            return GuardianChannelState(
                channel: channel,
                identity: voiceGuardianIdentity,
                username: voiceGuardianUsername,
                displayName: voiceGuardianDisplayName,
                verified: voiceGuardianVerified,
                inProgress: voiceGuardianVerificationInProgress,
                instruction: voiceGuardianInstruction,
                error: voiceGuardianError,
                alreadyBound: voiceGuardianAlreadyBound,
                outboundSessionId: voiceOutboundSessionId,
                outboundExpiresAt: voiceOutboundExpiresAt,
                outboundNextResendAt: voiceOutboundNextResendAt,
                outboundSendCount: voiceOutboundSendCount,
                outboundCode: voiceOutboundCode,
                bootstrapUrl: nil
            )
        case "slack":
            return GuardianChannelState(
                channel: channel,
                identity: slackGuardianIdentity,
                username: slackGuardianUsername,
                displayName: slackGuardianDisplayName,
                verified: slackGuardianVerified,
                inProgress: slackGuardianVerificationInProgress,
                instruction: slackGuardianInstruction,
                error: slackGuardianError,
                alreadyBound: slackGuardianAlreadyBound,
                outboundSessionId: slackOutboundSessionId,
                outboundExpiresAt: slackOutboundExpiresAt,
                outboundNextResendAt: slackOutboundNextResendAt,
                outboundSendCount: slackOutboundSendCount,
                outboundCode: slackOutboundCode,
                bootstrapUrl: nil
            )
        default:
            return GuardianChannelState(
                channel: channel,
                identity: nil,
                username: nil,
                displayName: nil,
                verified: false,
                inProgress: false,
                instruction: nil,
                error: nil,
                alreadyBound: false,
                outboundSessionId: nil,
                outboundExpiresAt: nil,
                outboundNextResendAt: nil,
                outboundSendCount: 0,
                outboundCode: nil,
                bootstrapUrl: nil
            )
        }
    }
}

// MARK: - Pure Helper Functions

/// Extracts a guardian verification code from a raw instruction string.
/// Supports two formats:
///   1. "N-digit code: <digits>" (numeric codes, e.g. "6-digit code: 123456")
///   2. "the code: <hex>" (high-entropy hex codes for inbound challenges)
func extractGuardianCommand(from instruction: String) -> String? {
    if let code = extractNumericCode(from: instruction) {
        return code
    }
    if let range = instruction.range(of: #"the code:\s*([0-9a-fA-F]+)"#, options: .regularExpression) {
        let match = String(instruction[range])
        if let hexRange = match.range(of: #"[0-9a-fA-F]{6,}"#, options: .regularExpression) {
            return String(match[hexRange])
        }
    }
    return nil
}

/// Extracts a numeric verification code from instruction text.
/// Matches the format "N-digit code: <digits>" used for identity-bound codes.
func extractNumericCode(from instruction: String) -> String? {
    guard let range = instruction.range(of: #"\d+-digit code:\s*(\d+)"#, options: .regularExpression) else {
        return nil
    }
    let match = String(instruction[range])
    guard let colonRange = match.range(of: #":\s*"#, options: .regularExpression) else {
        return nil
    }
    return String(match[colonRange.upperBound...])
}

/// Human-readable instruction text for the guardian verification flow.
/// Tells the user how to send the verification code for the given channel.
func guardianInstructionSubtext(channel: String, botUsername: String?, phoneNumber: String?) -> String {
    if channel == "telegram" {
        let handle = botUsername.map { "@\($0)" } ?? "your bot"
        return "Message \(handle) with the below code within the next 10 minutes"
    } else if channel == "voice" {
        let number = phoneNumber ?? "your assistant"
        return "Call \(number) and say the six-digit code below within the next 10 minutes"
    } else {
        let number = phoneNumber ?? "your assistant"
        return "Text \(number) with the below code within the next 10 minutes"
    }
}

/// Placeholder text for the guardian destination input field, varying by channel.
func guardianDestinationPlaceholder(for channel: String) -> String {
    switch channel {
    case "telegram": return "@username or chat ID"
    case "sms", "voice": return "+1234567890"
    case "slack": return "Slack user ID"
    default: return "Destination"
    }
}
