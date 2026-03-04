import SwiftUI

/// Deterministic icon generator that assigns an SF Symbol
/// based on a stable hash of the app name. Same name always produces the same icon.
public enum VAppIconGenerator {

    // MARK: - SF Symbols

    /// Curated SF Symbols suitable for generic app icons.
    public static let symbols: [String] = [
        "chart.line.uptrend.xyaxis",
        "doc.text",
        "globe",
        "camera",
        "music.note",
        "paintbrush",
        "wrench.and.screwdriver",
        "book",
        "envelope",
        "cart",
        "gamecontroller",
        "map",
        "cloud",
        "bolt",
        "heart",
        "star",
        "flag",
        "bookmark",
        "gift",
        "lightbulb",
        "lock",
        "magnifyingglass",
        "mic",
        "phone",
        "play.rectangle",
        "printer",
        "scissors",
        "shield",
        "wand.and.stars",
        "calendar",
    ]

    // MARK: - Generation

    /// Deterministic pick of SF Symbol based on a stable hash of the app name.
    /// The optional `type` parameter is mixed into the hash for additional differentiation.
    public static func generate(from name: String, type: String? = nil) -> String {
        let seed = type != nil ? "\(name):\(type!)" : name
        let hash = stableHash(seed)
        let symbolIndex = Int(hash % UInt64(symbols.count))
        return symbols[symbolIndex]
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
        VColor.background.ignoresSafeArea()
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text("Generated Icons")
                .font(VFont.headline)
                .foregroundColor(VColor.textPrimary)

            let sampleApps = ["Safari", "Notes", "Calendar", "Music", "Photos", "Maps"]
            LazyVGrid(columns: [
                GridItem(.adaptive(minimum: 80), spacing: VSpacing.lg)
            ], spacing: VSpacing.lg) {
                ForEach(sampleApps, id: \.self) { app in
                    let symbol = VAppIconGenerator.generate(from: app)
                    VStack(spacing: VSpacing.sm) {
                        Image(systemName: symbol)
                            .font(.system(size: 28, weight: .medium))
                            .foregroundColor(VColor.textMuted)
                            .frame(width: 64, height: 64)
                            .background(Moss._100)
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        Text(app)
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                    }
                }
            }
        }
        .padding()
    }
    .frame(width: 500, height: 300)
}
