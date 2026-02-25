import SwiftUI

/// Deterministic icon generator that assigns an SF Symbol and gradient color pair
/// based on a stable hash of the app name. Same name always produces the same icon.
public enum VAppIconGenerator {

    // MARK: - Gradient Palettes

    /// Curated gradient color pairs covering a range of hues.
    static let gradientPalettes: [[String]] = [
        ["#7C3AED", "#4F46E5"],  // violet
        ["#059669", "#10B981"],  // emerald
        ["#D97706", "#F59E0B"],  // amber
        ["#E11D48", "#F43F5E"],  // rose
        ["#4338CA", "#6366F1"],  // indigo
        ["#0284C7", "#38BDF8"],  // sky
        ["#EA580C", "#FB923C"],  // orange
        ["#0D9488", "#2DD4BF"],  // teal
        ["#DB2777", "#F472B6"],  // pink
        ["#65A30D", "#84CC16"],  // lime
        ["#0891B2", "#22D3EE"],  // cyan
        ["#475569", "#94A3B8"],  // slate
    ]

    // MARK: - SF Symbols

    /// Curated SF Symbols suitable for generic app icons.
    static let symbols: [String] = [
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

    /// Deterministic pick of SF Symbol and gradient colors based on a stable hash of the app name.
    /// The optional `type` parameter is mixed into the hash for additional differentiation.
    public static func generate(from name: String, type: String? = nil) -> (sfSymbol: String, colors: [String]) {
        let seed = type != nil ? "\(name):\(type!)" : name
        let hash = stableHash(seed)

        let symbolIndex = Int(hash % UInt64(symbols.count))
        // Use a different part of the hash for palette selection to avoid correlation
        let paletteIndex = Int((hash / UInt64(symbols.count)) % UInt64(gradientPalettes.count))

        return (sfSymbol: symbols[symbolIndex], colors: gradientPalettes[paletteIndex])
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
        .padding()
    }
    .frame(width: 500, height: 300)
}
