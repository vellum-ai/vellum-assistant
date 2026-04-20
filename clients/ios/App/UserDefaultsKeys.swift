#if canImport(UIKit)
import Foundation

enum UserDefaultsKeys {
    static let appearanceMode = "appearance_mode"
    static let gatewayBaseURL = "gateway_base_url"
    static let conversationKey = "conversation_key"

    // Media embed settings
    static let mediaEmbedsEnabled = "media_embeds_enabled"
    static let mediaEmbedVideoAllowlistDomains = "media_embed_video_allowlist_domains"

    // Managed assistant settings (cloud-hosted via Vellum platform)
    static let managedAssistantId = "managed_assistant_id"
    static let managedPlatformBaseURL = "managed_platform_base_url"
}
#endif
