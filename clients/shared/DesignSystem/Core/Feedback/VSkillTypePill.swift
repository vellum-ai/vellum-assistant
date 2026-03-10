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

        var vIcon: VIcon {
            switch self {
            case .core: return .package
            case .installed: return .circleCheck
            case .created: return .sparkles
            case .extra: return .puzzle
            case .custom(_, let icon, _, _): return .resolve(icon)
            }
        }

        var foregroundColor: Color {
            switch self {
            case .core: return VColor.skillCoreForeground
            case .installed: return VColor.skillInstalledForeground
            case .created: return VColor.skillCreatedForeground
            case .extra: return VColor.skillExtraForeground
            case .custom(_, _, let fg, _): return fg
            }
        }

        var backgroundColor: Color {
            switch self {
            case .core: return VColor.skillCoreBackground
            case .installed: return VColor.skillInstalledBackground
            case .created: return VColor.skillCreatedBackground
            case .extra: return VColor.skillExtraBackground
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
                icon: VIcon.puzzle.rawValue,
                foreground: VColor.skillExtraForeground,
                background: VColor.skillExtraBackground
            )
        }
    }

    public var body: some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(type.vIcon, size: 10)
            Text(type.label)
                .font(VFont.caption)
        }
        .foregroundColor(type.foregroundColor)
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(type.backgroundColor)
        )
    }
}
