import SwiftUI

/// A pill badge indicating the type/source of a skill (Core, Installed, Created).
public struct VSkillTypePill: View {
    public enum SkillType {
        case core
        case installed
        case created
        case extra
        case custom(label: String, icon: String, foreground: Color, background: Color)

        var label: String {
            switch self {
            case .core: return "Core"
            case .installed: return "Installed"
            case .created: return "Created"
            case .extra: return "Extra"
            case .custom(let label, _, _, _): return label
            }
        }

        var icon: String {
            switch self {
            case .core: return "building.2.fill"
            case .installed: return "checkmark.circle.fill"
            case .created: return "sparkles"
            case .extra: return "puzzlepiece.fill"
            case .custom(_, let icon, _, _): return icon
            }
        }

        var foregroundColor: Color {
            switch self {
            case .core: return Color(hex: 0x4A4A3E)
            case .installed: return Color(hex: 0x3A6B3A)
            case .created: return Color(hex: 0x3A4A6B)
            case .extra: return Color(hex: 0x6B6B5E)
            case .custom(_, _, let fg, _): return fg
            }
        }

        var backgroundColor: Color {
            switch self {
            case .core: return Color(hex: 0xDDDBCE)
            case .installed: return Color(hex: 0xD4E8D4)
            case .created: return Color(hex: 0xD4DCE8)
            case .extra: return Color(hex: 0xDDDBCE)
            case .custom(_, _, _, let bg): return bg
            }
        }
    }

    public let type: SkillType

    public init(type: SkillType) {
        self.type = type
    }

    /// Convenience initializer from a skill source string.
    public init(source: String) {
        switch source {
        case "bundled":
            self.type = .core
        case "managed", "clawhub":
            self.type = .installed
        case "workspace":
            self.type = .created
        case "extra":
            self.type = .extra
        default:
            self.type = .custom(
                label: source.replacingOccurrences(of: "-", with: " ").capitalized,
                icon: "puzzlepiece.fill",
                foreground: Color(hex: 0x6B6B5E),
                background: Color(hex: 0xDDDBCE)
            )
        }
    }

    public var body: some View {
        HStack(spacing: VSpacing.xs) {
            Image(systemName: type.icon)
                .font(.system(size: 10, weight: .medium))
            Text(type.label)
                .font(VFont.caption)
        }
        .foregroundColor(type.foregroundColor)
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .background(
            Capsule()
                .fill(type.backgroundColor)
        )
    }
}
