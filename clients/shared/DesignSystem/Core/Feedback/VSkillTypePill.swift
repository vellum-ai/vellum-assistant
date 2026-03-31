import SwiftUI

/// A pill badge indicating the source/provenance of a skill.
public struct VSkillTypePill: View {
    public enum SkillType {
        case vellum
        case community
        case custom
        case available
        case other(label: String, icon: String, foreground: Color, background: Color)

        var label: String {
            switch self {
            case .vellum: return "Vellum"
            case .community: return "Community"
            case .custom: return "Custom"
            case .available: return "Available"
            case .other(let label, _, _, _): return label
            }
        }

        var vIcon: VIcon {
            switch self {
            case .vellum: return .package
            case .community: return .globe
            case .custom: return .user
            case .available: return .arrowDownToLine
            case .other(_, let icon, _, _): return .resolve(icon)
            }
        }

        var foregroundColor: Color {
            switch self {
            case .vellum: return VColor.primaryBase
            case .community: return VColor.funTeal
            case .custom: return VColor.funPurple
            case .available: return VColor.funTeal
            case .other(_, _, let fg, _): return fg
            }
        }

        var backgroundColor: Color {
            switch self {
            case .vellum: return VColor.primaryBase.opacity(0.12)
            case .community: return VColor.funTeal.opacity(0.12)
            case .custom: return VColor.funPurple.opacity(0.12)
            case .available: return VColor.funTeal.opacity(0.12)
            case .other(_, _, _, let bg): return bg
            }
        }
    }

    public let type: SkillType

    public init(type: SkillType) {
        self.type = type
    }

    /// Convenience initializer from a skill source string and optional provenance kind.
    /// - Parameters:
    ///   - source: The skill source (e.g. "bundled", "managed", "clawhub", "workspace", "extra", "catalog")
    ///   - provenanceKind: Optional provenance kind (e.g. "first-party", "third-party", "local")
    public init(source: String, provenanceKind: String? = nil) {
        switch source {
        case "bundled":
            self.type = .vellum
        case "clawhub":
            self.type = .community
        case "managed":
            switch provenanceKind {
            case "first-party":
                self.type = .vellum
            case "third-party":
                self.type = .community
            default:
                self.type = .custom
            }
        case "workspace", "extra":
            self.type = .custom
        case "catalog":
            self.type = .available
        default:
            self.type = .other(
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
