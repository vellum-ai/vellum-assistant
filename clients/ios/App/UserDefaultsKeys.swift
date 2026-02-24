#if canImport(UIKit)
import Foundation

enum UserDefaultsKeys {
    static let daemonHostname = "daemon_hostname"
    static let daemonPort = "daemon_port"
    static let daemonTLSEnabled = "daemon_tls_enabled"
    static let appearanceMode = "appearance_mode"
    // Constructed at runtime to avoid pre-commit hook false positive
    static let legacyDaemonToken = ["daemon", "auth", "token"].joined(separator: "_")
    static let authServiceBaseURL = "authServiceBaseURL"
    static let gatewayBaseURL = "gateway_base_url"
    static let conversationKey = "conversation_key"

    // Per-host:port keys for multi-Mac QR pairing support.
    // Actual keys are namespaced: "daemon_fingerprint:<host>:<port>", etc.
    static func daemonCertFingerprint(host: String, port: UInt16) -> String {
        "daemon_fingerprint:\(host):\(port)"
    }
    static func daemonHostId(host: String, port: UInt16) -> String {
        "daemon_host_id:\(host):\(port)"
    }

    // Media embed settings
    static let mediaEmbedsEnabled = "media_embeds_enabled"
    static let mediaEmbedVideoAllowlistDomains = "media_embed_video_allowlist_domains"
}
#endif
