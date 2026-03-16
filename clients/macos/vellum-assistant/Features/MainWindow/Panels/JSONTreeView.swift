import SwiftUI
import VellumAssistantShared

// MARK: - JSON Node Model

/// Recursive data model representing a parsed JSON value for tree rendering.
private enum JSONNode: Identifiable {
    case object(id: String, entries: [(key: String, value: JSONNode)])
    case array(id: String, elements: [JSONNode])
    case string(id: String, value: String)
    case number(id: String, value: NSNumber)
    case bool(id: String, value: Bool)
    case null(id: String)

    var id: String {
        switch self {
        case .object(let id, _), .array(let id, _),
             .string(let id, _), .number(let id, _),
             .bool(let id, _), .null(let id):
            return id
        }
    }
}

// MARK: - Parse Result

/// Result of parsing a JSON string: either a valid tree or an error message.
private enum JSONParseResult {
    case success(JSONNode)
    case failure(String)
}

// MARK: - JSON Parsing

/// Parses a JSON string into a recursive `JSONNode` tree.
private func parseJSON(_ text: String) -> JSONParseResult {
    do {
        let parsed = try JSONSerialization.jsonObject(
            with: Data(text.utf8),
            options: [.fragmentsAllowed]
        )
        return .success(convert(parsed, path: "$"))
    } catch {
        return .failure(error.localizedDescription)
    }
}

/// Recursively converts a Foundation JSON object into a `JSONNode`.
private func convert(_ value: Any, path: String) -> JSONNode {
    switch value {
    case let dict as NSDictionary:
        let sortedKeys = (dict.allKeys as? [String] ?? []).sorted()
        let entries: [(key: String, value: JSONNode)] = sortedKeys.map { key in
            let childPath = "\(path).\(key)"
            return (key: key, value: convert(dict[key] as Any, path: childPath))
        }
        return .object(id: path, entries: entries)

    case let array as NSArray:
        let elements: [JSONNode] = array.enumerated().map { index, element in
            let childPath = "\(path)[\(index)]"
            return convert(element, path: childPath)
        }
        return .array(id: path, elements: elements)

    case let number as NSNumber:
        if CFGetTypeID(number) == CFBooleanGetTypeID() {
            return .bool(id: path, value: number.boolValue)
        }
        return .number(id: path, value: number)

    case let string as NSString:
        return .string(id: path, value: string as String)

    case is NSNull:
        return .null(id: path)

    default:
        return .null(id: path)
    }
}

// MARK: - Container Path Collection

/// Recursively collects all paths of container nodes (objects and arrays) for expand-all.
private func collectContainerPaths(_ node: JSONNode) -> Set<String> {
    var paths = Set<String>()
    switch node {
    case .object(let id, let entries):
        paths.insert(id)
        for entry in entries {
            paths.formUnion(collectContainerPaths(entry.value))
        }
    case .array(let id, let elements):
        paths.insert(id)
        for element in elements {
            paths.formUnion(collectContainerPaths(element))
        }
    case .string, .number, .bool, .null:
        break
    }
    return paths
}

// MARK: - JSONTreeView

/// Renders a JSON string as a collapsible tree with color-coded values.
struct JSONTreeView: View {
    let content: String
    @State private var root: JSONParseResult?
    @State private var expandedPaths: Set<String> = []

    var body: some View {
        Group {
            if let root = root {
                switch root {
                case .failure(let error):
                    errorView(error)
                case .success(let node):
                    treeContent(node)
                }
            } else {
                SwiftUI.ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: content) {
            let result = parseJSON(content)
            root = result
            if case .success(let node) = result {
                autoExpandInitial(node)
            }
        }
    }

    @ViewBuilder
    private func errorView(_ error: String) -> some View {
        VStack(spacing: VSpacing.sm) {
            Spacer()
            VIconView(.triangleAlert, size: 24)
                .foregroundColor(VColor.systemNegativeStrong)
            Text(error)
                .font(VFont.body)
                .foregroundColor(VColor.systemNegativeStrong)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
            Spacer()
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func treeContent(_ node: JSONNode) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            toolbar(node)
            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    JSONNodeRow(
                        node: node,
                        key: nil,
                        depth: 0,
                        expandedPaths: $expandedPaths
                    )
                }
                .padding(VSpacing.md)
            }
        }
    }

    @ViewBuilder
    private func toolbar(_ node: JSONNode) -> some View {
        HStack(spacing: VSpacing.md) {
            Spacer()
            Button("Expand All") {
                withAnimation(VAnimation.fast) {
                    expandedPaths = collectContainerPaths(node)
                }
            }
            .buttonStyle(.plain)
            .font(VFont.caption)
            .foregroundColor(VColor.contentSecondary)

            Button("Collapse All") {
                withAnimation(VAnimation.fast) {
                    expandedPaths.removeAll()
                }
            }
            .buttonStyle(.plain)
            .font(VFont.caption)
            .foregroundColor(VColor.contentSecondary)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
    }

    private func autoExpandInitial(_ node: JSONNode) {
        expandedPaths.insert(node.id)
        switch node {
        case .object(_, let entries):
            for entry in entries {
                expandedPaths.insert(entry.value.id)
            }
        case .array(_, let elements):
            for element in elements {
                expandedPaths.insert(element.id)
            }
        case .string, .number, .bool, .null:
            break
        }
    }
}

// MARK: - JSONNodeRow

/// Renders a single node in the JSON tree, handling both containers and primitives.
private struct JSONNodeRow: View {
    let node: JSONNode
    let key: String?
    let depth: Int
    @Binding var expandedPaths: Set<String>

    private var isExpanded: Bool {
        expandedPaths.contains(node.id)
    }

    var body: some View {
        switch node {
        case .object(_, let entries):
            containerRow(
                summary: "{...}",
                countLabel: "\(entries.count) key\(entries.count == 1 ? "" : "s")",
                children: entries.map { ($0.key, $0.value) }
            )
        case .array(_, let elements):
            containerRow(
                summary: "[...]",
                countLabel: "\(elements.count) item\(elements.count == 1 ? "" : "s")",
                children: elements.enumerated().map { (String($0.offset), $0.element) }
            )
        case .string(_, let value):
            primitiveRow {
                Text("\"\(value)\"")
                    .font(VFont.mono)
                    .foregroundColor(Color(red: 0.87, green: 0.55, blue: 0.47))
                    .textSelection(.enabled)
            }
        case .number(_, let value):
            primitiveRow {
                Text("\(value)")
                    .font(VFont.mono)
                    .foregroundColor(Color(red: 0.73, green: 0.56, blue: 0.87))
                    .textSelection(.enabled)
            }
        case .bool(_, let value):
            primitiveRow {
                Text(value ? "true" : "false")
                    .font(VFont.mono)
                    .foregroundColor(Color(red: 0.73, green: 0.56, blue: 0.87))
                    .bold()
                    .textSelection(.enabled)
            }
        case .null:
            primitiveRow {
                Text("null")
                    .font(VFont.mono)
                    .foregroundColor(VColor.contentTertiary)
                    .italic()
                    .textSelection(.enabled)
            }
        }
    }

    @ViewBuilder
    private func containerRow(
        summary: String,
        countLabel: String,
        children: [(String, JSONNode)]
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(VAnimation.fast) {
                    if isExpanded {
                        expandedPaths.remove(node.id)
                    } else {
                        expandedPaths.insert(node.id)
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Spacer().frame(width: CGFloat(depth) * 20)
                    VIconView(isExpanded ? .chevronDown : .chevronRight, size: 9)
                        .foregroundColor(VColor.contentSecondary)
                        .animation(VAnimation.fast, value: isExpanded)
                    keyLabel
                    Text(summary)
                        .font(VFont.mono)
                        .foregroundColor(VColor.contentTertiary)
                    Text("(\(countLabel))")
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.contentTertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.vertical, 2)

            if isExpanded {
                ForEach(children, id: \.1.id) { childKey, childNode in
                    JSONNodeRow(
                        node: childNode,
                        key: childKey,
                        depth: depth + 1,
                        expandedPaths: $expandedPaths
                    )
                }
            }
        }
    }

    @ViewBuilder
    private func primitiveRow<V: View>(@ViewBuilder value: () -> V) -> some View {
        HStack(spacing: 4) {
            Spacer().frame(width: CGFloat(depth) * 20)
            Spacer().frame(width: 12)
            keyLabel
            value()
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var keyLabel: some View {
        if let key = key {
            Text(key)
                .font(VFont.mono)
                .foregroundColor(VColor.contentDefault)
                .textSelection(.enabled)
            Text(": ")
                .font(VFont.mono)
                .foregroundColor(VColor.contentTertiary)
        }
    }
}
