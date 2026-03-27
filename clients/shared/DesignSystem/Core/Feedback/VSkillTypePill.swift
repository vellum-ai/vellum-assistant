import SwiftUI

/// A pill badge indicating the source/provenance of a skill.
public struct VSkillTypePill: View {
    public enum SkillType {
        case vellum
        case openclaw
        case managed
        case userMade
        case extra
        case available
        case custom(label: String, icon: String, foreground: Color, background: Color)

        var label: String {
            switch self {
            case .vellum: return "Vellum"
            case .openclaw: return "OpenClaw"
            case .managed: return "Managed"
            case .userMade: return "User Made"
            case .extra: return "Extra"
            case .available: return "Available"
            case .custom(let label, _, _, _): return label
            }
        }

        var vIcon: VIcon {
            switch self {
            case .vellum: return .package
            case .openclaw: return .globe
            case .managed: return .briefcase
            case .userMade: return .sparkles
            case .extra: return .puzzle
            case .available: return .arrowDownToLine
            case .custom(_, let icon, _, _): return .resolve(icon)
            }
        }

        var foregroundColor: Color {
            switch self {
            case .vellum: return VColor.primaryBase
            case .openclaw: return VColor.funTeal
            case .managed: return VColor.funPurple
            case .userMade: return VColor.contentSecondary
            case .extra: return VColor.contentTertiary
            case .available: return VColor.funTeal
            case .custom(_, _, let fg, _): return fg
            }
        }

        var backgroundColor: Color {
            switch self {
            case .vellum: return VColor.primaryBase.opacity(0.12)
            case .openclaw: return VColor.funTeal.opacity(0.12)
            case .managed: return VColor.funPurple.opacity(0.12)
            case .userMade: return VColor.surfaceOverlay
            case .extra: return VColor.surfaceOverlay
            case .available: return VColor.funTeal.opacity(0.12)
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
            self.type = .vellum
        case "clawhub":
            self.type = .openclaw
        case "managed":
            self.type = .managed
        case "workspace":
            self.type = .userMade
        case "extra":
            self.type = .extra
        case "catalog":
            self.type = .available
        default:
            self.type = .custom(
                label: source.replacingOccurrences(of: "-", with: " ").capitalized,
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
