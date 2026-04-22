#if DEBUG
import SwiftUI
import VellumAssistantShared

/// Gallery section for the chat above-composer error surfaces that live in
/// the macOS target and therefore can't be referenced from the shared
/// `ChatGallerySection`. Registers itself under the "chat" category via
/// `registerGalleryOverview(for: "chat")` so entries render alongside the
/// shared chat components.
///
/// Covers:
///   • `ChatConversationErrorToast` — both init paths (typed
///     `ConversationError` and unstructured message).
///   • `CreditsExhaustedBanner` — surface-colored "Add Funds" panel.
///   • `CompactionCircuitOpenBanner` — solid-accent "auto-compaction
///     paused" warning.
///   • `MissingApiKeyBanner` — surface-colored "Open Settings" panel with
///     a top-right dismiss.
struct ChatErrorSurfacesGallerySection: View {
    var filter: String?

    /// Fixed cooldown used for the compaction-circuit-open fixture. An
    /// hour from render time is enough to keep the banner on screen for
    /// any reasonable gallery session without triggering `onExpired`.
    private var fixtureCompactionCooldown: Date {
        Date().addingTimeInterval(60 * 60)
    }

    /// Register this section with the shared gallery router under the
    /// "chat" category so its entries appear alongside the shared chat
    /// sections.
    static func registerInGallery() {
        registerGalleryOverview(for: "chat") {
            AnyView(ChatErrorSurfacesGallerySection())
        }
        registerGalleryComponentPage(for: "chat") { componentID in
            AnyView(ChatErrorSurfacesGallerySection.componentPage(componentID))
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {

            // MARK: - ChatConversationErrorToast

            if filter == nil || filter == "chatConversationErrorToast" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "ChatConversationErrorToast",
                    description: "Unified error toast rendered above the chat composer. Solid-accent background with white text. Two init paths: (1) typed ConversationError — category-driven icon, color, and retry label plus a recovery suggestion and a copy-debug-info button; (2) unstructured message — custom icon, accent color, and optional action."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Typed ConversationError — retryable (providerNetwork)")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        ChatConversationErrorToast(
                            error: ConversationError(
                                category: .providerNetwork,
                                message: "Couldn't reach the model provider.",
                                isRetryable: true,
                                conversationId: "gallery-conv-1"
                            ),
                            onRetry: {},
                            onCopyDebugInfo: {},
                            onDismiss: {}
                        )

                        Divider().background(VColor.borderBase)

                        Text("Typed ConversationError — retryable (rateLimit)")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        ChatConversationErrorToast(
                            error: ConversationError(
                                category: .rateLimit,
                                message: "You're hitting the provider's rate limit.",
                                isRetryable: true,
                                conversationId: "gallery-conv-2"
                            ),
                            onRetry: {},
                            onCopyDebugInfo: {},
                            onDismiss: {}
                        )

                        Divider().background(VColor.borderBase)

                        Text("Typed ConversationError — non-retryable (authenticationRequired)")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        ChatConversationErrorToast(
                            error: ConversationError(
                                category: .authenticationRequired,
                                message: "Your session has expired. Sign in again to continue.",
                                isRetryable: false,
                                conversationId: "gallery-conv-3"
                            ),
                            onRetry: {},
                            onCopyDebugInfo: {},
                            onDismiss: {}
                        )

                        Divider().background(VColor.borderBase)

                        Text("Typed ConversationError — conversationAborted (positive accent)")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        ChatConversationErrorToast(
                            error: ConversationError(
                                category: .conversationAborted,
                                message: "Generation stopped.",
                                isRetryable: false,
                                conversationId: "gallery-conv-4"
                            ),
                            onRetry: {},
                            onCopyDebugInfo: {},
                            onDismiss: {}
                        )

                        Divider().background(VColor.borderBase)

                        Text("Typed ConversationError — contextTooLarge")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        ChatConversationErrorToast(
                            error: ConversationError(
                                category: .contextTooLarge,
                                message: "This conversation is too long for the model's context window.",
                                isRetryable: true,
                                conversationId: "gallery-conv-5"
                            ),
                            onRetry: {},
                            onCopyDebugInfo: {},
                            onDismiss: {}
                        )
                    }
                }

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Unstructured message — default (red, alert icon, dismiss only)")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        ChatConversationErrorToast(
                            message: "Something went wrong sending your message.",
                            onDismiss: {}
                        )

                        Divider().background(VColor.borderBase)

                        Text("Unstructured message — custom icon, mid-strong accent, action")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        ChatConversationErrorToast(
                            message: "Draft saved locally — we'll retry once you're back online.",
                            subtitle: "Your last edit is safe.",
                            icon: .wifiOff,
                            accentColor: VColor.systemMidStrong,
                            actionLabel: "Retry",
                            onAction: {},
                            onDismiss: {}
                        )

                        Divider().background(VColor.borderBase)

                        Text("Unstructured message — no action, no dismiss (pure notice)")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        ChatConversationErrorToast(
                            message: "Reconnecting to your assistant…",
                            icon: .refreshCw,
                            accentColor: VColor.systemInfoStrong
                        )
                    }
                }
            }

            // MARK: - CreditsExhaustedBanner

            if filter == nil || filter == "creditsExhaustedBanner" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "CreditsExhaustedBanner",
                    description: "Above-composer surface panel shown when the user's balance runs out. Warm tone with emoji + subtitle + primary \"Add Funds\" VButton. Uses UnevenRoundedRectangle (top corners only) because it sits flush against the composer below."
                )

                VCard {
                    CreditsExhaustedBanner(onAddFunds: {})
                }
            }

            // MARK: - CompactionCircuitOpenBanner

            if filter == nil || filter == "compactionCircuitOpenBanner" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "CompactionCircuitOpenBanner",
                    description: "Solid-accent warning shown when auto-compaction has been paused after repeated summary-LLM failures. No buttons — the banner polls a 1-minute ticker and fires onExpired once openUntil elapses. Gallery fixture uses a 1-hour-future deadline so the banner stays visible."
                )

                VCard {
                    CompactionCircuitOpenBanner(
                        openUntil: fixtureCompactionCooldown,
                        onExpired: {}
                    )
                }
            }

            // MARK: - MissingApiKeyBanner

            if filter == nil || filter == "missingApiKeyBanner" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "MissingApiKeyBanner",
                    description: "Above-composer surface panel shown when the user tries to chat without a configured API key. Top-right X dismiss + title + subtitle + full-width \"Open Settings\" primary VButton. Shares the UnevenRoundedRectangle (top corners only) treatment with CreditsExhaustedBanner."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("With dismiss")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        MissingApiKeyBanner(
                            onOpenSettings: {},
                            onDismiss: {}
                        )

                        Divider().background(VColor.borderBase)

                        Text("Without dismiss (onDismiss = nil)")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        MissingApiKeyBanner(
                            onOpenSettings: {},
                            onDismiss: nil
                        )
                    }
                }
            }
        }
    }
}

// MARK: - Component Page Router

extension ChatErrorSurfacesGallerySection {
    @ViewBuilder
    static func componentPage(_ id: String) -> some View {
        switch id {
        case "chatConversationErrorToast":
            ChatErrorSurfacesGallerySection(filter: "chatConversationErrorToast")
        case "creditsExhaustedBanner":
            ChatErrorSurfacesGallerySection(filter: "creditsExhaustedBanner")
        case "compactionCircuitOpenBanner":
            ChatErrorSurfacesGallerySection(filter: "compactionCircuitOpenBanner")
        case "missingApiKeyBanner":
            ChatErrorSurfacesGallerySection(filter: "missingApiKeyBanner")
        default:
            EmptyView()
        }
    }
}
#endif
