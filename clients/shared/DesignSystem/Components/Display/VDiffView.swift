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
        if line.hasPrefix("--- a/") || line.hasPrefix("--- /dev/null") { return .context }
        if line.hasPrefix("+++ b/") || line.hasPrefix("+++ /dev/null") { return .context }
        if line.hasPrefix("@@") { return .hunk }
        if line.hasPrefix("+") { return .added }
        if line.hasPrefix("-") { return .removed }
        return .context
    }

    private static func lineBackground(_ kind: LineKind) -> Color {
        switch kind {
        case .added: return VColor.diffAddedBg
        case .removed: return VColor.diffRemovedBg
        case .hunk: return VColor.diffHunkBg
        case .context: return .clear
        }
    }

    // MARK: - State

    @State private var lines: [(text: String, kind: LineKind)]?

    // MARK: - Body

    public var body: some View {
        let effectiveMaxHeight = maxHeight ?? 400
        ScrollView([.horizontal, .vertical], showsIndicators: false) {
            if let lines {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        HStack(spacing: 0) {
                            Text(line.text)
                                .font(VFont.bodySmallDefault)
                                .foregroundStyle(VColor.contentSecondary)
                                .fixedSize(horizontal: true, vertical: true)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, VSpacing.xs)
                        .padding(.vertical, 1)
                        .background(Self.lineBackground(line.kind))
                    }
                }
                .fixedSize(horizontal: true, vertical: false)
            } else {
                ProgressView()
                    .scaleEffect(0.6)
                    .frame(maxWidth: .infinity, minHeight: 40)
            }
        }
        .frame(maxHeight: effectiveMaxHeight)
        .textSelection(.enabled)
        .task {
            let t = text
            let result = await Task.detached(priority: .userInitiated) {
                t.split(separator: "\n", omittingEmptySubsequences: false).map { line in
                    (text: line.isEmpty ? " " : String(line), kind: Self.classify(line))
                }
            }.value
            lines = result
        }
    }
}
