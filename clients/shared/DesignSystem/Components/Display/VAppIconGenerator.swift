import SwiftUI

/// Deterministic icon generator that assigns a Lucide icon (VIcon)
/// based on a stable hash of the app name. Same name always produces the same icon.
public enum VAppIconGenerator {

    // MARK: - Icons

    /// Curated Lucide icons suitable for generic app icons.
    public static let icons: [VIcon] = [
        // Original 30 (migrated from SF Symbols)
        .trendingUp,
        .fileText,
        .globe,
        .camera,
        .music,
        .paintbrush,
        .wrench,
        .bookOpen,
        .mail,
        .shoppingCart,
        .gamepad,
        .map,
        .cloud,
        .zap,
        .heart,
        .star,
        .flag,
        .bookmark,
        .gift,
        .lightbulb,
        .lock,
        .search,
        .mic,
        .phone,
        .video,
        .printer,
        .scissors,
        .shield,
        .wand,
        .calendar,

        // Expanded offering
        .rocket,
        .palette,
        .headphones,
        .graduationCap,
        .trophy,
        .plane,
        .utensils,
        .dumbbell,
        .flask,
        .clapperboard,
        .briefcase,
        .tent,
        .bike,
        .penTool,
        .musicNotes,
        .compass,
        .brain,
        .cpu,
        .creditCard,
        .puzzle,
        .stethoscope,
        .car,
        .sparkles,
        .terminal,
        .receipt,
    ]

    // MARK: - Generation

    /// Deterministic pick of VIcon based on a stable hash of the app name.
    /// The optional `type` parameter is mixed into the hash for additional differentiation.
    public static func generate(from name: String, type: String? = nil) -> VIcon {
        let seed = type != nil ? "\(name):\(type!)" : name
        let hash = stableHash(seed)
        let iconIndex = Int(hash % UInt64(icons.count))
        return icons[iconIndex]
    }

    /// Simple stable hash — FNV-1a 64-bit. Deterministic and consistent across runs.
    private static func stableHash(_ string: String) -> UInt64 {
        var hash: UInt64 = 14695981039346656037 // FNV offset basis
        for byte in string.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1099511628211 // FNV prime
        }
        return hash
    }
}

#Preview("VAppIconGenerator") {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text("Generated Icons")
                .font(VFont.headline)
                .foregroundColor(VColor.contentDefault)

            let sampleApps = ["Safari", "Notes", "Calendar", "Music", "Photos", "Maps"]
            LazyVGrid(columns: [
                GridItem(.adaptive(minimum: 80), spacing: VSpacing.lg)
            ], spacing: VSpacing.lg) {
                ForEach(sampleApps, id: \.self) { app in
                    let icon = VAppIconGenerator.generate(from: app)
                    VStack(spacing: VSpacing.sm) {
                        VIconView(icon, size: 28)
                            .foregroundColor(VColor.contentTertiary)
                            .frame(width: 64, height: 64)
                            .background(VColor.surfaceBase)
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        Text(app)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                    }
                }
            }
        }
        .padding()
    }
    .frame(width: 500, height: 300)
}
