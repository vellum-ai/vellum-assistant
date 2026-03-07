#if DEBUG
import SwiftUI

struct DisplayGallerySection: View {
    @State private var cardPadding: CGFloat = 24

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
                            .foregroundColor(VColor.textSecondary)
                        Slider(value: $cardPadding, in: 0...48, step: 4)
                            .frame(maxWidth: 200)
                    }

                    Divider().background(VColor.surfaceBorder)

                    VCard(padding: cardPadding) {
                        Text("Card content with \(Int(cardPadding))pt padding")
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                    }
                }
            }

            // Padding variants
            Text("Padding Variants")
                .font(VFont.headline)
                .foregroundColor(VColor.textSecondary)

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
                                .foregroundColor(VColor.textPrimary)
                            Text("\(Int(padding))pt")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                    }
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

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

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

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
                    .foregroundColor(VColor.textSecondary)
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)

            VDisclosureSection(
                title: "With Subtitle",
                subtitle: "Additional context shown below the title",
                isExpanded: .constant(false)
            ) {
                Text("This content is hidden")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

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
                                .foregroundColor(VColor.accent)
                            Text("Tappable row with icon")
                                .font(VFont.body)
                                .foregroundColor(VColor.textPrimary)
                            Spacer()
                            VIconView(.chevronRight, size: 10)
                                .foregroundColor(VColor.textMuted)
                        }
                    }

                    Divider().background(VColor.surfaceBorder)

                    VListRow(onTap: {}) {
                        HStack {
                            VIconView(.folder, size: 14)
                                .foregroundColor(VColor.warning)
                            Text("Another tappable row")
                                .font(VFont.body)
                                .foregroundColor(VColor.textPrimary)
                            Spacer()
                            VBadge(style: .count(3))
                        }
                    }

                    Divider().background(VColor.surfaceBorder)

                    VListRow {
                        Text("Static row (no tap action)")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                    }
                }
            }
        }
    }
}
#endif
