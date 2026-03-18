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
                            .foregroundColor(VColor.contentSecondary)
                        Slider(value: $badgeCount, in: 1...99, step: 1)
                            .frame(maxWidth: 200)
                    }

                    Divider().background(VColor.borderBase)

                    // Count row
                    HStack(spacing: VSpacing.xl) {
                        VStack(spacing: VSpacing.xs) {
                            Text("Accent").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VBadge(style: .count(Int(badgeCount)), color: VColor.primaryBase)
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Success").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VBadge(style: .count(Int(badgeCount)), color: VColor.systemPositiveStrong)
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Error").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VBadge(style: .count(Int(badgeCount)), color: VColor.systemNegativeStrong)
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Warning").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VBadge(style: .count(Int(badgeCount)), color: VColor.systemNegativeHover)
                        }
                    }

                    // Dot row
                    HStack(spacing: VSpacing.xl) {
                        VStack(spacing: VSpacing.xs) {
                            Text("Dot").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            HStack(spacing: VSpacing.md) {
                                VBadge(style: .dot, color: VColor.primaryBase)
                                VBadge(style: .dot, color: VColor.systemPositiveStrong)
                                VBadge(style: .dot, color: VColor.systemNegativeStrong)
                                VBadge(style: .dot, color: VColor.systemNegativeHover)
                            }
                        }
                    }

                    // Label row
                    HStack(spacing: VSpacing.lg) {
                        VBadge(style: .label("New"), color: VColor.primaryBase)
                        VBadge(style: .label("Beta"), color: VColor.systemPositiveStrong)
                        VBadge(style: .label("Error"), color: VColor.systemNegativeStrong)
                        VBadge(style: .label("Warn"), color: VColor.systemNegativeHover)
                    }

                    // Icon label row
                    HStack(spacing: VSpacing.lg) {
                        VStack(spacing: VSpacing.xs) {
                            Text("With iconColor").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VBadge(label: "Guardian", icon: .shieldCheck, iconColor: VColor.primaryBase, tone: .neutral)
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Default iconColor").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VBadge(label: "Status", icon: .sparkles, tone: .accent)
                        }
                    }

                    Divider().background(VColor.borderBase)

                    // Rounded shape
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Rounded shape").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        HStack(spacing: VSpacing.lg) {
                            VBadge(label: "Identity", color: VColor.funTeal, shape: .rounded)
                            VBadge(label: "Preference", color: VColor.funPurple, shape: .rounded)
                            VBadge(label: "Project", color: VColor.funGreen, shape: .rounded)
                            VBadge(label: "Decision", color: VColor.funYellow, shape: .rounded)
                            VBadge(label: "Constraint", color: VColor.funCoral, shape: .rounded)
                            VBadge(label: "Event", color: VColor.funPink, shape: .rounded)
                        }
                    }

                    // Pill shape with custom color
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Pill shape with custom color").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        HStack(spacing: VSpacing.lg) {
                            VBadge(label: "Teal", color: VColor.funTeal)
                            VBadge(label: "Purple", color: VColor.funPurple)
                            VBadge(label: "Coral", color: VColor.funCoral)
                        }
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VLoadingIndicator
            GallerySectionHeader(
                title: "VLoadingIndicator",
                description: "Spinning loading indicator with configurable size and color."
            )

            VCard {
                HStack(spacing: VSpacing.xxl) {
                    VStack(spacing: VSpacing.md) {
                        Text("Small (14)").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VLoadingIndicator(size: 14, color: VColor.primaryBase)
                    }
                    VStack(spacing: VSpacing.md) {
                        Text("Default (20)").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VLoadingIndicator()
                    }
                    VStack(spacing: VSpacing.md) {
                        Text("Large (32)").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VLoadingIndicator(size: 32, color: VColor.primaryBase)
                    }
                    VStack(spacing: VSpacing.md) {
                        Text("Success").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VLoadingIndicator(color: VColor.systemPositiveStrong)
                    }
                    VStack(spacing: VSpacing.md) {
                        Text("Error").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VLoadingIndicator(color: VColor.systemNegativeStrong)
                    }
                    VStack(spacing: VSpacing.md) {
                        Text("Warning").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VLoadingIndicator(color: VColor.systemNegativeHover)
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

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

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VInlineMessage
            GallerySectionHeader(
                title: "VInlineMessage",
                description: "Compact inline banner for form status, warnings, and errors."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    VInlineMessage("This setting will sync the next time the assistant reconnects.", tone: .info)
                    VInlineMessage("Your Twilio configuration is incomplete.", tone: .warning)
                    VInlineMessage("This Telegram token was rejected by the provider.", tone: .error)
                    VInlineMessage("Phone verification is complete.", tone: .success)
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

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
                            Text("Text only").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VShortcutTag("\u{2318}K")
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Text only").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VShortcutTag("\u{2318}G")
                        }
                    }

                    Divider().background(VColor.borderBase)

                    // With icon
                    HStack(spacing: VSpacing.lg) {
                        VStack(spacing: VSpacing.xs) {
                            Text("With icon").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VShortcutTag("fn", icon: "mic.fill")
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("With icon").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VShortcutTag("Esc", icon: "escape")
                        }
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VToast with Copyable Detail
            GallerySectionHeader(
                title: "VToast with Copyable Detail",
                description: "Error toast with a clipboard button that copies debug information."
            )

            VStack(spacing: VSpacing.md) {
                VToast(
                    message: "Request failed unexpectedly.",
                    style: .error,
                    copyableDetail: "RequestError: timeout after 30s at /v1/chat/completions (req_abc123)"
                )
                VToast(
                    message: "Could not connect to provider.",
                    style: .error,
                    copyableDetail: "ConnectionRefused: 127.0.0.1:8080",
                    primaryAction: VToastAction(label: "Retry") {},
                    onDismiss: {}
                )
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

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
                    message: "Conversation was interrupted.",
                    style: .warning,
                    onDismiss: {}
                )
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VSkeletonBone
            GallerySectionHeader(
                title: "VSkeletonBone",
                description: "Rounded rectangle placeholder with shimmer animation for loading states."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Default (full-width, 14pt)").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VSkeletonBone()
                    }

                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Custom widths").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VSkeletonBone(width: 100)
                        VSkeletonBone(width: 200)
                        VSkeletonBone(width: 160)
                    }

                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Custom heights").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        HStack(spacing: VSpacing.lg) {
                            VSkeletonBone(width: 80, height: 8)
                            VSkeletonBone(width: 80, height: 14)
                            VSkeletonBone(width: 80, height: 24)
                        }
                    }

                    Divider().background(VColor.borderBase)

                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Composable skeleton layout").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        HStack(alignment: .top, spacing: VSpacing.md) {
                            VSkeletonBone(width: 40, height: 40, radius: VRadius.md)
                            VStack(alignment: .leading, spacing: VSpacing.sm) {
                                VSkeletonBone(width: 120, height: 14)
                                VSkeletonBone(height: 10)
                                VSkeletonBone(width: 180, height: 10)
                            }
                        }
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VBusyIndicator
            GallerySectionHeader(
                title: "VBusyIndicator",
                description: "Pulsing circle indicator for active processing state."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Sizes").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        HStack(spacing: VSpacing.xxl) {
                            VStack(spacing: VSpacing.xs) {
                                Text("6pt").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                                VBusyIndicator(size: 6)
                            }
                            VStack(spacing: VSpacing.xs) {
                                Text("10pt (default)").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                                VBusyIndicator()
                            }
                            VStack(spacing: VSpacing.xs) {
                                Text("16pt").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                                VBusyIndicator(size: 16)
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Colors").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        HStack(spacing: VSpacing.xxl) {
                            VStack(spacing: VSpacing.xs) {
                                Text("Primary").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                                VBusyIndicator()
                            }
                            VStack(spacing: VSpacing.xs) {
                                Text("Success").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                                VBusyIndicator(color: VColor.systemPositiveStrong)
                            }
                            VStack(spacing: VSpacing.xs) {
                                Text("Error").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                                VBusyIndicator(color: VColor.systemNegativeStrong)
                            }
                        }
                    }

                    Divider().background(VColor.borderBase)

                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("With label").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        HStack(spacing: VSpacing.sm) {
                            VBusyIndicator(size: 8)
                            Text("Processing...")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentSecondary)
                        }
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VSkillTypePill
            GallerySectionHeader(
                title: "VSkillTypePill",
                description: "Badge indicating skill type/source with icon and color."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Built-in types").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        HStack(spacing: VSpacing.lg) {
                            VSkillTypePill(type: .core)
                            VSkillTypePill(type: .installed)
                            VSkillTypePill(type: .created)
                            VSkillTypePill(type: .extra)
                        }
                    }

                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Custom type").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VSkillTypePill(type: .custom(
                            label: "Community",
                            icon: VIcon.globe.rawValue,
                            foreground: VColor.funTeal,
                            background: VColor.surfaceOverlay
                        ))
                    }

                    Divider().background(VColor.borderBase)

                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("From source string").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        HStack(spacing: VSpacing.lg) {
                            VSkillTypePill(source: "bundled")
                            VSkillTypePill(source: "managed")
                            VSkillTypePill(source: "workspace")
                            VSkillTypePill(source: "extra")
                        }
                    }
                }
            }
        }
    }
}
#endif
