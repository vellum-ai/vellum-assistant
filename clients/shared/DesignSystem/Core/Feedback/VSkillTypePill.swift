import SwiftUI

/// A pill badge indicating the source of a skill.
public struct VSkillTypePill: View {
    public enum SkillType {
        case vellum
        case clawhub
        case skillssh
        case custom
        case other(label: String, icon: String, foreground: Color, background: Color)

        var label: String {
            switch self {
            case .vellum: return "Vellum"
            case .clawhub: return "Clawhub"
            case .skillssh: return "skills.sh"
            case .custom: return "Custom"
            case .other(let label, _, _, _): return label
            }
        }

        var vIcon: VIcon {
            switch self {
            case .vellum: return .package
            case .clawhub: return .globe
            case .skillssh: return .terminal
            case .custom: return .user
            case .other(_, let icon, _, _): return .resolve(icon)
            }
        }

        var foregroundColor: Color {
            switch self {
            case .vellum: return VColor.primaryBase
            case .clawhub: return VColor.funTeal
            case .skillssh: return VColor.funCoral
            case .custom: return VColor.funPurple
            case .other(_, _, let fg, _): return fg
            }
        }

        var backgroundColor: Color {
            switch self {
            case .vellum: return VColor.primaryBase.opacity(0.12)
            case .clawhub: return VColor.funTeal.opacity(0.12)
            case .skillssh: return VColor.funCoral.opacity(0.12)
            case .custom: return VColor.funPurple.opacity(0.12)
            case .other(_, _, _, let bg): return bg
            }
        }
    }

    public let type: SkillType

    public init(type: SkillType) {
        self.type = type
    }

    /// Convenience initializer from a skill origin string.
    public init(origin: String) {
        switch origin {
        case "vellum":
            self.type = .vellum
        case "clawhub":
            self.type = .clawhub
        case "skillssh":
            self.type = .skillssh
        case "custom":
            self.type = .custom
        default:
            self.type = .other(
                label: origin.replacingOccurrences(of: "-", with: " ").capitalized,
                icon: VIcon.puzzle.rawValue,
                foreground: VColor.contentTertiary,
                background: VColor.surfaceOverlay
            )
        }
    }

    public var body: some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(type.vIcon, size: 10)
            Text(type.label)
                .font(VFont.labelDefault)
        }
        .foregroundStyle(type.foregroundColor)
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(type.backgroundColor)
        )
    }
}
