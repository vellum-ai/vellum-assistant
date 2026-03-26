#if DEBUG
import SwiftUI
import VellumAssistantShared

struct AvatarGallerySection: View {
    @State private var isStreaming: Bool = false
    @State private var breathingEnabled: Bool = true
    @State private var blinkEnabled: Bool = true
    @State private var pokeTrigger: Int = 0
    @State private var entryTrigger: Int = 0

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            GallerySectionHeader(
                title: "AnimatedAvatarView",
                description: "Live-rendered avatar with CAShapeLayer. Supports breathing, blinking, poke, streaming body-morph, and entry animations."
            )

            // MARK: - Animation Controls
            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    Text("Animation Controls").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                    HStack(spacing: VSpacing.xxl) {
                        AnimatedAvatarView(
                            bodyShape: .cloud,
                            eyeStyle: .goofy,
                            color: .teal,
                            size: 80,
                            breathingEnabled: breathingEnabled,
                            blinkEnabled: blinkEnabled,
                            isStreaming: isStreaming,
                            pokeTrigger: pokeTrigger,
                            entryTrigger: entryTrigger
                        )
                        .frame(width: 80, height: 80)

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            VToggle(isOn: $isStreaming, label: "Streaming")
                            VToggle(isOn: $breathingEnabled, label: "Breathing")
                            VToggle(isOn: $blinkEnabled, label: "Blinking")
                        }

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Button("Play Entry") { entryTrigger += 1 }
                                .buttonStyle(.bordered)
                            Button("Play Poke") { pokeTrigger += 1 }
                                .buttonStyle(.bordered)
                        }
                    }
                }
            }

            // MARK: - All Body Shapes
            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    Text("All Body Shapes").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: VSpacing.lg), count: 5), spacing: VSpacing.lg) {
                        ForEach(AvatarBodyShape.allCases) { shape in
                            VStack(spacing: VSpacing.xs) {
                                AnimatedAvatarView(
                                    bodyShape: shape,
                                    eyeStyle: .goofy,
                                    color: .teal,
                                    size: 64,
                                    isStreaming: isStreaming
                                )
                                .frame(width: 64, height: 64)
                                Text(shape.rawValue)
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentTertiary)
                            }
                        }
                    }
                }
            }

            // MARK: - Sizes
            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    Text("Sizes").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                    HStack(spacing: VSpacing.xl) {
                        ForEach([32, 52, 80] as [CGFloat], id: \.self) { size in
                            VStack(spacing: VSpacing.xs) {
                                AnimatedAvatarView(
                                    bodyShape: .cloud,
                                    eyeStyle: .goofy,
                                    color: .teal,
                                    size: size,
                                    isStreaming: isStreaming
                                )
                                .frame(width: size, height: size)
                                Text("\(Int(size))pt")
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentTertiary)
                            }
                        }
                    }
                }
            }
        }
    }

    /// Register this page in the shared gallery router.
    static func registerInGallery() {
        registerDisplayGalleryPage(id: "animatedAvatar") {
            AnyView(AvatarGallerySection())
        }
    }
}
#endif
