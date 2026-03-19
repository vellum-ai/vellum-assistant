import AppKit
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

    /// Returns a JSON-formatted string representation of this node,
    /// suitable for copying to the pasteboard.
    var serializedValue: String {
        switch self {
        case .object(_, let entries):
            let obj = entries.reduce(into: [String: Any]()) { dict, entry in
                dict[entry.key] = entry.value.toFoundation()
            }
            return Self.prettyPrint(obj)
        case .array(_, let elements):
            return Self.prettyPrint(elements.map { $0.toFoundation() })
        case .string(_, let value):
            return value
        case .number(_, let value):
            return "\(value)"
        case .bool(_, let value):
            return value ? "true" : "false"
        case .null:
            return "null"
        }
    }

    /// Converts this node back into a Foundation object for serialization.
    private func toFoundation() -> Any {
        switch self {
        case .object(_, let entries):
            return entries.reduce(into: [String: Any]()) { dict, entry in
                dict[entry.key] = entry.value.toFoundation()
            }
        case .array(_, let elements):
            return elements.map { $0.toFoundation() }
        case .string(_, let value):
            return value
        case .number(_, let value):
            return value
        case .bool(_, let value):
            return value
        case .null:
            return NSNull()
        }
    }

    private static func prettyPrint(_ obj: Any) -> String {
        guard let data = try? JSONSerialization.data(
            withJSONObject: obj,
            options: [.prettyPrinted, .withoutEscapingSlashes]
        ) else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
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

/// Escapes a JSON key for use in node ID paths, preventing ambiguity when keys
/// contain path-separator characters like `.`, `[`, or `]`.
private func escapeKey(_ key: String) -> String {
    key.replacingOccurrences(of: "\\", with: "\\\\")
       .replacingOccurrences(of: ".", with: "\\.")
       .replacingOccurrences(of: "[", with: "\\[")
       .replacingOccurrences(of: "]", with: "\\]")
}

/// Recursively converts a Foundation JSON object into a `JSONNode`.
private func convert(_ value: Any, path: String) -> JSONNode {
    switch value {
    case let dict as NSDictionary:
        let sortedKeys = (dict.allKeys as? [String] ?? []).sorted()
        let entries: [(key: String, value: JSONNode)] = sortedKeys.map { key in
            let childPath = "\(path).\(escapeKey(key))"
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
///
/// Expand/collapse all can be triggered externally by incrementing
/// `expandAllTrigger` or `collapseAllTrigger`.
struct JSONTreeView: View {
    let content: String
    var expandAllTrigger: Int = 0
    var collapseAllTrigger: Int = 0
    @State private var root: JSONParseResult?
    @State private var expandedPaths: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
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
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task(id: content) {
            let result = parseJSON(content)
            root = result
            expandedPaths = []
            if case .success(let node) = result {
                autoExpandInitial(node)
            }
        }
        .onChange(of: expandAllTrigger) { _, _ in
            if case .success(let node) = root {
                withAnimation(VAnimation.fast) {
                    expandedPaths = collectContainerPaths(node)
                }
            }
        }
        .onChange(of: collapseAllTrigger) { _, _ in
            withAnimation(VAnimation.fast) {
                expandedPaths.removeAll()
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
            GeometryReader { proxy in
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
                    .frame(minWidth: proxy.size.width, minHeight: proxy.size.height, alignment: .topLeading)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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
                    .foregroundColor(VColor.syntaxString)
            }
        case .number(_, let value):
            primitiveRow {
                Text("\(value)")
                    .font(VFont.mono)
                    .foregroundColor(VColor.syntaxNumber)
            }
        case .bool(_, let value):
            primitiveRow {
                Text(value ? "true" : "false")
                    .font(VFont.mono)
                    .foregroundColor(VColor.syntaxNumber)
                    .bold()
            }
        case .null:
            primitiveRow {
                Text("null")
                    .font(VFont.mono)
                    .foregroundColor(VColor.contentTertiary)
                    .italic()
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
            NodeCopyWrapper(node: node) {
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
            }

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
        NodeCopyWrapper(node: node) {
            HStack(spacing: 4) {
                Spacer().frame(width: CGFloat(depth) * 20)
                Spacer().frame(width: 12)
                keyLabel
                value()
            }
        }
    }

    @ViewBuilder
    private var keyLabel: some View {
        if let key = key {
            Text(key)
                .font(VFont.mono)
                .foregroundColor(VColor.contentDefault)
            Text(": ")
                .font(VFont.mono)
                .foregroundColor(VColor.contentTertiary)
        }
    }
}

// MARK: - Node Copy Wrapper

/// Wraps a JSON node row with a hover-to-copy button and right-click context menu.
/// The copy button appears on the trailing edge when the user hovers over the row.
private struct NodeCopyWrapper<Content: View>: View {
    let node: JSONNode
    let content: Content
    @State private var isHovered = false

    init(node: JSONNode, @ViewBuilder content: () -> Content) {
        self.node = node
        self.content = content()
    }

    var body: some View {
        HStack(spacing: 4) {
            content

            if isHovered {
                VCopyButton(text: node.serializedValue, iconSize: 20, accessibilityHint: "Copy value")
                    .transition(.opacity)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onHover { hovering in
            withAnimation(VAnimation.fast) {
                isHovered = hovering
            }
        }
        .contextMenu {
            Button("Copy Value") {
                #if os(macOS)
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(node.serializedValue, forType: .string)
                #endif
            }
        }
    }
}
