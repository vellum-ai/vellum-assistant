#if DEBUG
import SwiftUI

struct AppIconGallerySection: View {
    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
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
                        let icon = VAppIconGenerator.generate(from: app)
                        VStack(spacing: VSpacing.sm) {
                            VIconView(icon, size: 28)
                                .foregroundStyle(VColor.contentTertiary)
                                .frame(width: 64, height: 64)
                                .background(VColor.surfaceBase)
                                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                            Text(app)
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentSecondary)
                        }
                    }
                }
            }
        }
    }
}
#endif
