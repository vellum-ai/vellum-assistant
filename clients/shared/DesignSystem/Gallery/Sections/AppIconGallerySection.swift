#if DEBUG
import SwiftUI

struct AppIconGallerySection: View {
    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            // MARK: - VAppIcon Sizes
            GallerySectionHeader(
                title: "VAppIcon",
                description: "iOS-style app icon with SF Symbol on a gradient rounded-rect background."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    Text("Sizes")
                        .font(VFont.headline)
                        .foregroundColor(VColor.textSecondary)

                    HStack(spacing: VSpacing.xxl) {
                        VStack(spacing: VSpacing.sm) {
                            VAppIcon(
                                sfSymbol: "globe",
                                gradientColors: ["#7C3AED", "#4F46E5"],
                                size: .small
                            )
                            Text("Small (32pt)")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        VStack(spacing: VSpacing.sm) {
                            VAppIcon(
                                sfSymbol: "globe",
                                gradientColors: ["#7C3AED", "#4F46E5"],
                                size: .medium
                            )
                            Text("Medium (64pt)")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        VStack(spacing: VSpacing.sm) {
                            VAppIcon(
                                sfSymbol: "globe",
                                gradientColors: ["#7C3AED", "#4F46E5"],
                                size: .large
                            )
                            Text("Large (96pt)")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                    }
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Sample Grid
            GallerySectionHeader(
                title: "Sample Icons",
                description: "Different gradient and symbol combinations across all palette colors."
            )

            let sampleIcons: [(symbol: String, colors: [String], label: String)] = [
                ("chart.line.uptrend.xyaxis", ["#7C3AED", "#4F46E5"], "Analytics"),
                ("camera", ["#E11D48", "#F43F5E"], "Camera"),
                ("music.note", ["#0284C7", "#38BDF8"], "Music"),
                ("paintbrush", ["#D97706", "#F59E0B"], "Design"),
                ("envelope", ["#059669", "#10B981"], "Mail"),
                ("gamecontroller", ["#DB2777", "#F472B6"], "Games"),
            ]

            VCard {
                LazyVGrid(columns: [
                    GridItem(.adaptive(minimum: 100), spacing: VSpacing.lg)
                ], spacing: VSpacing.xl) {
                    ForEach(sampleIcons, id: \.label) { item in
                        VStack(spacing: VSpacing.sm) {
                            VAppIcon(
                                sfSymbol: item.symbol,
                                gradientColors: item.colors,
                                size: .medium
                            )
                            Text(item.label)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textSecondary)
                        }
                    }
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - VAppIconGenerator
            GallerySectionHeader(
                title: "VAppIconGenerator",
                description: "Deterministic icon assignment — same app name always produces the same icon."
            )

            let generatedApps = ["Safari", "Notes", "Calendar", "Music", "Photos", "Slack"]

            VCard {
                LazyVGrid(columns: [
                    GridItem(.adaptive(minimum: 100), spacing: VSpacing.lg)
                ], spacing: VSpacing.xl) {
                    ForEach(generatedApps, id: \.self) { app in
                        let result = VAppIconGenerator.generate(from: app)
                        VStack(spacing: VSpacing.sm) {
                            VAppIcon(
                                sfSymbol: result.sfSymbol,
                                gradientColors: result.colors,
                                size: .medium
                            )
                            Text(app)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textSecondary)
                        }
                    }
                }
            }
        }
    }
}
#endif
