#if DEBUG
import SwiftUI

struct DisplayGallerySection: View {
    @State private var cardPadding: CGFloat = 24
    @State private var waveformAmplitude: Float = 0.5
    @State private var waveformActive: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            // MARK: - VCard
            GallerySectionHeader(
                title: "VCard",
                description: "Container with surface background, border, and configurable padding."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    HStack {
                        Text("Padding: \(Int(cardPadding))pt")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                        Slider(value: $cardPadding, in: 0...48, step: 4)
                            .frame(maxWidth: 200)
                    }

                    Divider().background(VColor.borderBase)

                    VCard(padding: cardPadding) {
                        Text("Card content with \(Int(cardPadding))pt padding")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                    }
                }
            }

            // Padding variants
            Text("Padding Variants")
                .font(VFont.headline)
                .foregroundColor(VColor.contentSecondary)

            HStack(spacing: VSpacing.lg) {
                ForEach([
                    ("xs", VSpacing.xs),
                    ("sm", VSpacing.sm),
                    ("md", VSpacing.md),
                    ("lg", VSpacing.lg),
                    ("xl", VSpacing.xl)
                ], id: \.0) { name, padding in
                    VCard(padding: padding) {
                        VStack(spacing: VSpacing.xs) {
                            Text(name)
                                .font(VFont.captionMedium)
                                .foregroundColor(VColor.contentDefault)
                            Text("\(Int(padding))pt")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                        }
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VEmptyState
            GallerySectionHeader(
                title: "VEmptyState",
                description: "Centered placeholder for empty content areas."
            )

            HStack(spacing: VSpacing.lg) {
                VCard {
                    VEmptyState(
                        title: "No items",
                        subtitle: "Create your first item to get started",
                        icon: "tray"
                    )
                    .frame(height: 200)
                }
                VCard {
                    VEmptyState(title: "No results")
                        .frame(height: 200)
                }
                VCard {
                    VEmptyState(
                        title: "Empty inbox",
                        icon: VIcon.mail.rawValue
                    )
                    .frame(height: 200)
                }
            }

            Text("With Action Button")
                .font(VFont.headline)
                .foregroundColor(VColor.contentSecondary)

            HStack(spacing: VSpacing.lg) {
                VCard {
                    VEmptyState(
                        title: "No contacts yet",
                        icon: VIcon.users.rawValue,
                        actionLabel: "Add Contact",
                        actionIcon: VIcon.plus.rawValue,
                        action: {}
                    )
                    .frame(height: 200)
                }
                VCard {
                    VEmptyState(
                        title: "No documents",
                        subtitle: "Upload a file to get started",
                        icon: VIcon.fileText.rawValue,
                        actionLabel: "Upload",
                        action: {}
                    )
                    .frame(height: 200)
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VDisclosureSection
            GallerySectionHeader(
                title: "VDisclosureSection",
                description: "Full-row clickable disclosure with animated chevron. Replaces DisclosureGroup."
            )

            VDisclosureSection(
                title: "Basic Section",
                isExpanded: .constant(true)
            ) {
                Text("Expanded content is visible")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceOverlay)

            VDisclosureSection(
                title: "With Subtitle",
                subtitle: "Additional context shown below the title",
                isExpanded: .constant(false)
            ) {
                Text("This content is hidden")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceOverlay)

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VListRow
            GallerySectionHeader(
                title: "VListRow",
                description: "List item with hover highlight and optional tap action."
            )

            VCard(padding: 0) {
                VStack(spacing: 0) {
                    VListRow(onTap: {}) {
                        HStack {
                            VIconView(.fileText, size: 14)
                                .foregroundColor(VColor.primaryBase)
                            Text("Tappable row with icon")
                                .font(VFont.body)
                                .foregroundColor(VColor.contentDefault)
                            Spacer()
                            VIconView(.chevronRight, size: 10)
                                .foregroundColor(VColor.contentTertiary)
                        }
                    }

                    Divider().background(VColor.borderBase)

                    VListRow(onTap: {}) {
                        HStack {
                            VIconView(.folder, size: 14)
                                .foregroundColor(VColor.systemNegativeHover)
                            Text("Another tappable row")
                                .font(VFont.body)
                                .foregroundColor(VColor.contentDefault)
                            Spacer()
                            VBadge(style: .count(3))
                        }
                    }

                    Divider().background(VColor.borderBase)

                    VListRow {
                        Text("Static row (no tap action)")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentSecondary)
                    }
                }
            }
            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VActionCard
            GallerySectionHeader(
                title: "VActionCard",
                description: "Tappable card for action choices with icon, title, subtitle, and optional chevron. Hover highlight and pointer cursor built in."
            )

            VStack(spacing: VSpacing.sm) {
                VActionCard(
                    icon: VIcon.settings.rawValue,
                    label: "Configure Settings",
                    subtitle: "Adjust preferences and options"
                ) {}

                VActionCard(
                    icon: VIcon.plus.rawValue,
                    label: "Add New Item",
                    subtitle: "Create something new"
                ) {}

                VActionCard(
                    icon: VIcon.trash.rawValue,
                    label: "Delete Account",
                    subtitle: "This action cannot be undone",
                    destructive: true,
                    showChevron: false
                ) {}
            }
            .frame(width: 320)

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VAvatarImage
            #if os(macOS)
            GallerySectionHeader(
                title: "VAvatarImage",
                description: "Avatar with transparency-aware clip shape. Transparent images show full artwork; opaque images clip to a circle."
            )

            HStack(spacing: VSpacing.lg) {
                ForEach([
                    ("24pt", CGFloat(24)),
                    ("28pt", CGFloat(28)),
                    ("40pt", CGFloat(40)),
                    ("52pt", CGFloat(52)),
                ], id: \.0) { label, size in
                    VStack(spacing: VSpacing.xs) {
                        VAvatarImage(
                            image: NSImage(systemSymbolName: "person.circle.fill", accessibilityDescription: nil)!,
                            size: size
                        )
                        Text(label)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
            #endif

            // MARK: - VStreamingWaveform
            GallerySectionHeader(
                title: "VStreamingWaveform",
                description: "Animated audio waveform driven by amplitude. Two styles: conversation (centered) and dictation (bottom-aligned)."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    HStack(spacing: VSpacing.xl) {
                        VStack(spacing: VSpacing.sm) {
                            Text("Conversation")
                                .font(VFont.captionMedium)
                                .foregroundColor(VColor.contentSecondary)
                            VStreamingWaveform(
                                amplitude: waveformAmplitude,
                                isActive: waveformActive,
                                style: .conversation
                            )
                            .frame(width: 120, height: 60)
                        }

                        VStack(spacing: VSpacing.sm) {
                            Text("Dictation")
                                .font(VFont.captionMedium)
                                .foregroundColor(VColor.contentSecondary)
                            VStreamingWaveform(
                                amplitude: waveformAmplitude,
                                isActive: waveformActive,
                                style: .dictation,
                                foregroundColor: VColor.contentSecondary
                            )
                            .frame(width: 100, height: 30)
                        }
                    }

                    Divider().background(VColor.borderBase)

                    HStack {
                        Text("Amplitude: \(String(format: "%.2f", waveformAmplitude))")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                        Slider(value: Binding(
                            get: { Double(waveformAmplitude) },
                            set: { waveformAmplitude = Float($0) }
                        ), in: 0...1)
                        .frame(maxWidth: 200)
                    }

                    Toggle("Active", isOn: $waveformActive)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentDefault)
                }
            }
        }
    }
}
#endif
