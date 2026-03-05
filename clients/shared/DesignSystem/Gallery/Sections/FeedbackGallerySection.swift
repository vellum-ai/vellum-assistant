#if DEBUG
import SwiftUI

struct FeedbackGallerySection: View {
    @State private var badgeCount: Double = 5

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            // MARK: - VBadge
            GallerySectionHeader(
                title: "VBadge",
                description: "Compact status indicator: count, dot, or label."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    // Count badges with slider
                    HStack {
                        Text("Count: \(Int(badgeCount))")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                        Slider(value: $badgeCount, in: 1...99, step: 1)
                            .frame(maxWidth: 200)
                    }

                    Divider().background(VColor.surfaceBorder)

                    // Count row
                    HStack(spacing: VSpacing.xl) {
                        VStack(spacing: VSpacing.xs) {
                            Text("Accent").font(VFont.caption).foregroundColor(VColor.textMuted)
                            VBadge(style: .count(Int(badgeCount)), color: VColor.accent)
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Success").font(VFont.caption).foregroundColor(VColor.textMuted)
                            VBadge(style: .count(Int(badgeCount)), color: VColor.success)
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Error").font(VFont.caption).foregroundColor(VColor.textMuted)
                            VBadge(style: .count(Int(badgeCount)), color: VColor.error)
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Warning").font(VFont.caption).foregroundColor(VColor.textMuted)
                            VBadge(style: .count(Int(badgeCount)), color: VColor.warning)
                        }
                    }

                    // Dot row
                    HStack(spacing: VSpacing.xl) {
                        VStack(spacing: VSpacing.xs) {
                            Text("Dot").font(VFont.caption).foregroundColor(VColor.textMuted)
                            HStack(spacing: VSpacing.md) {
                                VBadge(style: .dot, color: VColor.accent)
                                VBadge(style: .dot, color: VColor.success)
                                VBadge(style: .dot, color: VColor.error)
                                VBadge(style: .dot, color: VColor.warning)
                            }
                        }
                    }

                    // Label row
                    HStack(spacing: VSpacing.lg) {
                        VBadge(style: .label("New"), color: VColor.accent)
                        VBadge(style: .label("Beta"), color: VColor.success)
                        VBadge(style: .label("Error"), color: VColor.error)
                        VBadge(style: .label("Warn"), color: VColor.warning)
                    }
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - VLoadingIndicator
            GallerySectionHeader(
                title: "VLoadingIndicator",
                description: "Spinning loading indicator with configurable size and color."
            )

            VCard {
                HStack(spacing: VSpacing.xxl) {
                    VStack(spacing: VSpacing.md) {
                        Text("Small (14)").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VLoadingIndicator(size: 14, color: VColor.accent)
                    }
                    VStack(spacing: VSpacing.md) {
                        Text("Default (20)").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VLoadingIndicator()
                    }
                    VStack(spacing: VSpacing.md) {
                        Text("Large (32)").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VLoadingIndicator(size: 32, color: VColor.accent)
                    }
                    VStack(spacing: VSpacing.md) {
                        Text("Success").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VLoadingIndicator(color: VColor.success)
                    }
                    VStack(spacing: VSpacing.md) {
                        Text("Error").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VLoadingIndicator(color: VColor.error)
                    }
                    VStack(spacing: VSpacing.md) {
                        Text("Warning").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VLoadingIndicator(color: VColor.warning)
                    }
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - VToast
            GallerySectionHeader(
                title: "VToast",
                description: "Notification toast with info, success, warning, and error styles."
            )

            VStack(spacing: VSpacing.md) {
                VToast(message: "Here's some useful information.", style: .info)
                VToast(message: "Operation completed successfully!", style: .success)
                VToast(message: "Please check your configuration.", style: .warning)
                VToast(message: "Something went wrong.", style: .error)
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - VShortcutTag
            GallerySectionHeader(
                title: "VShortcutTag",
                description: "Clickable pill displaying a keyboard shortcut hint, with optional icon."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    // Text only
                    HStack(spacing: VSpacing.lg) {
                        VStack(spacing: VSpacing.xs) {
                            Text("Text only").font(VFont.caption).foregroundColor(VColor.textMuted)
                            VShortcutTag("\u{2318}K")
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Text only").font(VFont.caption).foregroundColor(VColor.textMuted)
                            VShortcutTag("\u{2318}G")
                        }
                    }

                    Divider().background(VColor.surfaceBorder)

                    // With icon
                    HStack(spacing: VSpacing.lg) {
                        VStack(spacing: VSpacing.xs) {
                            Text("With icon").font(VFont.caption).foregroundColor(VColor.textMuted)
                            VShortcutTag("fn", icon: "mic.fill")
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("With icon").font(VFont.caption).foregroundColor(VColor.textMuted)
                            VShortcutTag("Esc", icon: "escape")
                        }
                    }
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - VToast with Actions
            GallerySectionHeader(
                title: "VToast with Actions",
                description: "Error toasts with retry, copy debug, and dismiss actions."
            )

            VStack(spacing: VSpacing.md) {
                VToast(
                    message: "Network error. Check your connection.",
                    style: .error,
                    primaryAction: VToastAction(label: "Retry") {},
                    onDismiss: {}
                )
                VToast(
                    message: "The AI provider returned an error.",
                    style: .error,
                    primaryAction: VToastAction(label: "Retry") {},
                    secondaryAction: VToastAction(label: "Copy Debug Info") {},
                    onDismiss: {}
                )
                VToast(
                    message: "Session was interrupted.",
                    style: .warning,
                    onDismiss: {}
                )
            }
        }
    }
}
#endif
