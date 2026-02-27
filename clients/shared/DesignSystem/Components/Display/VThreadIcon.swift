import SwiftUI

/// A deterministic initial-letter icon for threads.
///
/// Renders the first letter of a thread title (uppercased) inside a rounded square
/// whose background color is derived from an FNV-1a hash of the title. The same title
/// always produces the same color, giving threads a stable visual identity.
public struct VThreadIcon: View {
    let title: String
    let size: Size
    var isActive: Bool = false
    /// Optional dot color for interaction-state overlay (bottom-right corner).
    /// Callers map ThreadInteractionState → Color externally to keep the
    /// design system decoupled from feature types.
    var dotColor: Color?

    public enum Size {
        /// 20pt — for popover list items
        case small
        /// 28pt — for collapsed sidebar
        case medium

        var dimension: CGFloat {
            switch self {
            case .small: return 20
            case .medium: return 28
            }
        }

        var fontSize: CGFloat {
            switch self {
            case .small: return 11
            case .medium: return 14
            }
        }

        var cornerRadius: CGFloat {
            switch self {
            case .small: return VRadius.sm
            case .medium: return VRadius.md
            }
        }

        /// Size of the interaction-state overlay dot.
        var dotSize: CGFloat {
            switch self {
            case .small: return 6
            case .medium: return 8
            }
        }

        var borderWidth: CGFloat {
            switch self {
            case .small: return 1.5
            case .medium: return 2
            }
        }
    }

    // MARK: - Color Palette

    /// Muted, dark-theme-friendly hex values that complement the Moss/Forest palette.
    private static let backgroundHexValues: [UInt] = [
        0x4B6845, // forest green
        0x4A5568, // slate blue-gray
        0x5B4E3A, // warm brown
        0x3D5A5B, // teal
        0x6B4C5A, // muted mauve
        0x4E5D3E, // olive
        0x5A4A6B, // dusty purple
        0x5C6B4A, // sage
    ]

    // MARK: - Hash

    /// FNV-1a 64-bit hash for deterministic color assignment.
    private static func stableHash(_ string: String) -> UInt64 {
        var hash: UInt64 = 14695981039346656037 // FNV offset basis
        for byte in string.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1099511628211 // FNV prime
        }
        return hash
    }

    // MARK: - Derived Properties

    private var letter: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "?" }
        return String(first).uppercased()
    }

    private var backgroundColor: Color {
        let hash = Self.stableHash(title)
        let index = Int(hash % UInt64(Self.backgroundHexValues.count))
        return Color(hex: Self.backgroundHexValues[index])
    }

    // MARK: - Body

    public var body: some View {
        ZStack(alignment: .bottomTrailing) {
            // Main icon
            ZStack {
                RoundedRectangle(cornerRadius: size.cornerRadius, style: .continuous)
                    .fill(backgroundColor)

                Text(letter)
                    .font(.system(size: size.fontSize, weight: .semibold, design: .rounded))
                    .foregroundColor(.white)
            }
            .frame(width: size.dimension, height: size.dimension)
            .overlay(
                RoundedRectangle(cornerRadius: size.cornerRadius, style: .continuous)
                    .stroke(isActive ? VColor.accent : Color.clear, lineWidth: size.borderWidth)
            )

            // Interaction-state overlay dot
            if let dot = dotColor {
                Circle()
                    .fill(dot)
                    .frame(width: size.dotSize, height: size.dotSize)
                    .offset(x: size.dotSize * 0.2, y: size.dotSize * 0.2)
            }
        }
        .accessibilityLabel("Thread: \(title)")
    }
}

// MARK: - Preview

#Preview("VThreadIcon") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: VSpacing.xl) {
            Text("Small (20pt)")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
            HStack(spacing: VSpacing.sm) {
                VThreadIcon(title: "Customer support", size: .small)
                VThreadIcon(title: "Design review", size: .small, isActive: true)
                VThreadIcon(title: "Bug triage", size: .small, dotColor: VColor.accent)
                VThreadIcon(title: "Sprint planning", size: .small, dotColor: VColor.warning)
                VThreadIcon(title: "Release notes", size: .small, dotColor: VColor.error)
            }

            Text("Medium (28pt)")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
            HStack(spacing: VSpacing.md) {
                VThreadIcon(title: "Customer support", size: .medium)
                VThreadIcon(title: "Design review", size: .medium, isActive: true)
                VThreadIcon(title: "Bug triage", size: .medium, dotColor: VColor.accent)
                VThreadIcon(title: "Sprint planning", size: .medium, dotColor: VColor.warning)
                VThreadIcon(title: "Release notes", size: .medium, dotColor: VColor.error)
            }

            Text("Deterministic colors")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
            HStack(spacing: VSpacing.md) {
                ForEach(["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"], id: \.self) { name in
                    VStack(spacing: VSpacing.xs) {
                        VThreadIcon(title: name, size: .medium)
                        Text(name)
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                    }
                }
            }
        }
        .padding()
    }
    .frame(width: 600, height: 300)
}
