#if DEBUG
import SwiftUI
import VellumAssistantShared

struct AvatarGallerySection: View {
    @State private var isStreaming: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            GallerySectionHeader(
                title: "AnimatedAvatarView",
                description: "Live-rendered avatar with CAShapeLayer. Supports breathing, blinking, poke, and streaming body-morph animations."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    VToggle(isOn: $isStreaming, label: "Streaming (body wobble)")

                    Divider().background(VColor.borderBase)

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

                    Divider().background(VColor.borderBase)

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
