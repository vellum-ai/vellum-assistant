import SwiftUI
import VellumAssistantShared

struct ConversationHostAccessControlConfiguration {
    let isEnabled: Bool
    let canToggle: Bool
    let isUpdating: Bool
    let subtitle: String
    let errorMessage: String?
    let onToggle: () -> Void
}
