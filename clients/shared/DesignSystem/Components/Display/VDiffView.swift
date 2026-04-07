import SwiftUI

/// Renders a unified diff string with per-line colored backgrounds.
/// Added lines (+) get a green tint, removed lines (-) get a red tint,
/// and hunk headers (@@) get a subtle accent.
public struct VDiffView: View {
    let text: String
    let maxHeight: CGFloat?

    public init(_ text: String, maxHeight: CGFloat? = nil) {
        self.text = text
        self.maxHeight = maxHeight
    }

    // MARK: - Line Classification

    private enum LineKind {
        case added, removed, hunk, context
    }

    private static func classify(_ line: Substring) -> LineKind {
        // Unified diff file headers ("--- a/...", "+++ b/...", "--- /dev/null", "+++ /dev/null").
        // Only match real headers to avoid misclassifying removed/added lines like "--- note".
        if line.hasPrefix("--- a/") || line.hasPrefix("--- /dev/null") { return .context }
        if line.hasPrefix("+++ b/") || line.hasPrefix("+++ /dev/null") { return .context }
        if line.hasPrefix("@@") { return .hunk }
        if line.hasPrefix("+") { return .added }
        if line.hasPrefix("-") { return .removed }
        return .context
    }

    // MARK: - Colors

    private static func lineBackground(_ kind: LineKind) -> Color {
        switch kind {
        case .added: return VColor.diffAddedBg
        case .removed: return VColor.diffRemovedBg
        case .hunk: return VColor.diffHunkBg
        case .context: return .clear
        }
    }

    // MARK: - Body

    public var body: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        if let maxHeight {
            let lineThreshold = Int(maxHeight / 16)
            if lines.count > lineThreshold {
                diffScrollView(lines: lines, axes: [.horizontal, .vertical])
                    .frame(height: maxHeight)
            } else {
                diffScrollView(lines: lines, axes: .horizontal)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            diffScrollView(lines: lines, axes: .horizontal)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func diffScrollView(lines: [Substring], axes: Axis.Set) -> some View {
        ScrollView(axes, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    diffLine(line)
                }
            }
            .fixedSize(horizontal: true, vertical: true)
        }
        .textSelection(.enabled)
    }

    private func diffLine(_ line: Substring) -> some View {
        let kind = Self.classify(line)
        return HStack(spacing: 0) {
            Text(line.isEmpty ? " " : String(line))
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
                .fixedSize(horizontal: true, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, VSpacing.xs)
        .padding(.vertical, 1)
        .background(Self.lineBackground(kind))
    }
}
