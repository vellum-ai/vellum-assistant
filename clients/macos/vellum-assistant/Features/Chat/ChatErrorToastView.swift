import SwiftUI
import VellumAssistantShared

// MARK: - Conversation Error Toast

/// Unified error toast displayed above the composer with solid accent background and white text.
///
/// Supports two initialization paths:
/// 1. From a typed `ConversationError` (category-based icon, color, and recovery suggestion)
/// 2. From an unstructured message string (icon, color, and action are customizable)
struct ChatConversationErrorToast: View {
    // MARK: - Display Properties

    private let icon: VIcon
    private let message: String
    private let subtitle: String?
    private let accent: Color
    private let actionLabel: String?
    private let onAction: (() -> Void)?
    private let showCopyDebug: Bool
    private let onCopyDebugInfo: (() -> Void)?
    private let onDismiss: (() -> Void)?

    // MARK: - ConversationError Init

    /// Initialize from a typed `ConversationError` with category-based styling.
    init(
        error: ConversationError,
        onRetry: @escaping () -> Void,
        onCopyDebugInfo: @escaping () -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.icon = Self.iconForCategory(error.category)
        self.message = error.message
        self.subtitle = error.recoverySuggestion
        self.accent = Self.accentColor(for: error.category)
        self.actionLabel = error.isRetryable ? Self.actionLabel(for: error.category) : nil
        self.onAction = error.isRetryable ? onRetry : nil
        self.showCopyDebug = true
        self.onCopyDebugInfo = onCopyDebugInfo
        self.onDismiss = onDismiss
    }

    // MARK: - Unstructured Message Init

    /// Initialize from an unstructured error message with customizable styling.
    init(
        message: String,
        subtitle: String? = nil,
        icon: VIcon = .circleAlert,
        accentColor: Color = VColor.systemNegativeStrong,
        actionLabel: String? = nil,
        onAction: (() -> Void)? = nil,
        onDismiss: (() -> Void)? = nil
    ) {
        self.icon = icon
        self.message = message
        self.subtitle = subtitle
        self.accent = accentColor
        self.actionLabel = actionLabel
        self.onAction = onAction
        self.showCopyDebug = false
        self.onCopyDebugInfo = nil
        self.onDismiss = onDismiss
    }

    // MARK: - Body

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(icon, size: 14)

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(message)
                    .font(VFont.bodyMediumLighter)
                    .lineLimit(nil)
                    .textSelection(.enabled)

                if let subtitle {
                    Text(subtitle)
                        .font(VFont.labelSmall)
                        .opacity(0.8)
                        .lineLimit(2)
                        .textSelection(.enabled)
                }
            }

            if actionLabel != nil || showCopyDebug || onDismiss != nil {
                Spacer(minLength: VSpacing.xl)
            }

            if let actionLabel, let onAction {
                Button(action: onAction) {
                    Text(actionLabel)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.auxWhite) // color-literal-ok
                        .padding(.horizontal, VSpacing.sm)
                        .frame(height: 24)
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .strokeBorder(VColor.auxWhite, lineWidth: 1.5)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(actionLabel)
            }

            if showCopyDebug, let onCopyDebugInfo {
                Button(action: onCopyDebugInfo) {
                    VIconView(.clipboard, size: 11)
                        .opacity(0.8)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy debug info")
            }

            if let onDismiss {
                Button {
                    onDismiss()
                } label: {
                    VIconView(.x, size: 14)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss error")
            }
        }
        .foregroundStyle(VColor.auxWhite) // Intentional: always white on solid accent background
        .centerAlignedMinHeight(32)
        .padding(.leading, VSpacing.md)
        .padding(.trailing, VSpacing.lg)
        .padding(.vertical, VSpacing.xs)
        .background(accent)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .transition(.move(edge: .top).combined(with: .opacity))
        .layoutHangSignpost("chat.errorToast")
    }

    // MARK: - Category Helpers

    /// VIcon appropriate for each error category.
    private static func iconForCategory(_ category: ConversationErrorCategory) -> VIcon {
        switch category {
        case .providerNetwork:
            return .wifiOff
        case .rateLimit, .managedUsageLimit:
            return .clockAlert
        case .providerOverloaded:
            return .cloudOff
        case .providerApi:
            return .cloudOff
        case .providerBilling:
            return .creditCard
        case .providerOrdering:
            return .cloudOff
        case .providerWebSearch:
            return .cloudOff
        case .contextTooLarge:
            return .fileText
        case .conversationAborted:
            return .circleStop
        case .processingFailed, .regenerateFailed:
            return .refreshCw
        case .authenticationRequired:
            return .lock
        case .providerNotConfigured, .managedKeyInvalid:
            return .keyRound
        case .unknown:
            return .circleAlert
        }
    }

    /// Accent color for each error category — warm for transient/retryable,
    /// red for hard failures.
    private static func accentColor(for category: ConversationErrorCategory) -> Color {
        switch category {
        case .rateLimit, .managedUsageLimit:
            return VColor.systemMidStrong
        case .providerNetwork:
            return VColor.systemMidStrong
        case .conversationAborted:
            return VColor.systemPositiveStrong
        case .contextTooLarge:
            return VColor.systemMidStrong
        case .providerOverloaded, .providerOrdering, .providerWebSearch:
            return VColor.systemMidStrong
        default:
            return VColor.systemNegativeStrong
        }
    }

    /// Action button label tailored to the error category.
    private static func actionLabel(for category: ConversationErrorCategory) -> String {
        switch category {
        case .rateLimit, .managedUsageLimit:
            return "Retry"
        case .regenerateFailed:
            return "Retry"
        case .providerNetwork:
            return "Retry"
        default:
            return "Retry"
        }
    }
}

// MARK: - Credits Exhausted Banner

/// Inline banner shown when the user's credits are exhausted.
/// Uses a warm, encouraging tone with a visual gauge and clear CTA.
struct CreditsExhaustedBanner: View {
    let onAddFunds: () -> Void

    var body: some View {
        HStack(spacing: VSpacing.xl) {
            VStack(alignment: .leading, spacing: 2) {
                Text("💰  Your balance has run out")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentEmphasized)
                Text("Add funds to pick up where you left off.")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
            .layoutPriority(1)

            Spacer(minLength: 0)

            VButton(label: "Add Funds", style: .primary) {
                onAddFunds()
            }
        }
        .padding(VSpacing.lg)
        .background(VColor.surfaceActive)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: VRadius.lg,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: VRadius.lg
            )
        )
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .layoutHangSignpost("chat.creditsExhaustedBanner")
    }
}

// MARK: - Disk Pressure Banner

/// Inline banner shown while the active assistant is reporting high disk usage.
struct DiskPressureBanner: View {
    let alert: DiskPressureAlert
    let onReviewDiskUsage: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: VSpacing.xl) {
            VStack(alignment: .leading, spacing: 2) {
                Text(Self.title)
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentEmphasized)
                Text(Self.subtitle(for: alert))
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }

            Spacer(minLength: VSpacing.lg)

            HStack(spacing: VSpacing.sm) {
                VButton(label: "Review Disk Usage", style: .primary) {
                    onReviewDiskUsage()
                }

                VButton(
                    label: "Dismiss disk space alert",
                    iconOnly: VIcon.x.rawValue,
                    style: .ghost,
                    size: .compact,
                    tooltip: "Dismiss"
                ) {
                    onDismiss()
                }
            }
        }
        .padding(VSpacing.lg)
        .background(VColor.surfaceActive)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: VRadius.lg,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: VRadius.lg
            )
        )
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .layoutHangSignpost("chat.diskPressureBanner")
    }

    static let title = "💾 It looks like you're running out of disk space."

    static func subtitle(for alert: DiskPressureAlert) -> String {
        "Storage is \(alert.displayPercent)% full. Try cleaning up unused data, like logs."
    }
}

enum DiskPressureBannerDismissalStore {
    static let dismissalDuration: TimeInterval = 24 * 60 * 60

    private static let keyPrefix = "diskPressureBanner.dismissedUntil."

    static func dismiss(alertId: String, now: Date = Date(), userDefaults: UserDefaults = .standard) {
        let dismissedUntil = now.addingTimeInterval(dismissalDuration)
        userDefaults.set(dismissedUntil.timeIntervalSince1970, forKey: key(for: alertId))
    }

    static func dismissedUntil(for alertId: String, userDefaults: UserDefaults = .standard) -> Date? {
        let timestamp = userDefaults.double(forKey: key(for: alertId))
        guard timestamp > 0 else { return nil }
        return Date(timeIntervalSince1970: timestamp)
    }

    static func isDismissed(alertId: String, now: Date = Date(), userDefaults: UserDefaults = .standard) -> Bool {
        guard let dismissedUntil = dismissedUntil(for: alertId, userDefaults: userDefaults) else { return false }
        guard dismissedUntil > now else {
            userDefaults.removeObject(forKey: key(for: alertId))
            return false
        }
        return true
    }

    private static func key(for alertId: String) -> String {
        keyPrefix + alertId
    }
}

// MARK: - Compaction Circuit Open Banner

/// Inline banner shown when the assistant has paused automatic context
/// compaction after three consecutive summary-LLM failures. Stays visible
/// while `openUntil` is in the future; auto-dismisses once the cooldown
/// elapses. A minute-granularity ticker is sufficient — the cooldown is
/// one hour and exact-second dismissal isn't user-visible.
struct CompactionCircuitOpenBanner: View {
    let openUntil: Date
    let onExpired: () -> Void

    /// One-minute ticker — the cooldown is an hour so minute granularity is
    /// adequate. On each tick we re-check `openUntil` and call `onExpired`
    /// once the deadline has passed so the parent can clear the VM property
    /// that gates this banner's visibility.
    private let timer = Timer.publish(every: 60, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.clockAlert, size: 14)

            Text("Auto-compaction paused — long conversation may overflow. Use /compact to compact manually.")
                .font(VFont.bodyMediumLighter)
                .lineLimit(nil)
                .textSelection(.enabled)
        }
        .foregroundStyle(VColor.auxWhite) // Intentional: white on solid accent background.
        .centerAlignedMinHeight(32)
        .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.md, bottom: VSpacing.xs, trailing: VSpacing.lg))
        .background(VColor.systemMidStrong)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .transition(.move(edge: .top).combined(with: .opacity))
        .layoutHangSignpost("chat.compactionCircuitOpenBanner")
        .onReceive(timer) { tick in
            if tick >= openUntil {
                onExpired()
            }
        }
    }
}

// MARK: - Missing API Key Banner

/// Inline banner shown when the user attempts to chat without a configured API key.
/// Presents a dismiss button, title, subtitle, and a full-width CTA to open settings.
struct MissingApiKeyBanner: View {
    let onOpenSettings: () -> Void
    let onDismiss: (() -> Void)?

    var body: some View {
        VStack(spacing: VSpacing.md) {
            HStack {
                Spacer()
                Button { onDismiss?() } label: {
                    VIconView(.x, size: 12)
                        .foregroundStyle(VColor.contentSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }

            VStack(spacing: VSpacing.xs) {
                Text("API key required")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentEmphasized)
                Text("Add an API key in Settings to start chatting.")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }

            VButton(label: "Open Settings", style: .primary, isFullWidth: true) {
                onOpenSettings()
            }
        }
        .padding(VSpacing.lg)
        .background(VColor.surfaceActive)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: VRadius.lg,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: VRadius.lg
            )
        )
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .layoutHangSignpost("chat.missingApiKeyBanner")
    }
}
