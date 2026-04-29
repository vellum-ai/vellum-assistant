/// A personality cluster that groups assistant names by communication style.
public struct PersonalityGroup: Sendable {
    public let id: String
    public let label: String
    public let descriptor: String
    public let names: [String]

    /// The four built-in personality groups.
    public static let allGroups: [PersonalityGroup] = [
        PersonalityGroup(
            id: "grounded",
            label: "Grounded",
            descriptor: "Calm and precise",
            names: ["Penn", "Sage", "Atlas", "Orion", "Reed", "Quill"]
        ),
        PersonalityGroup(
            id: "warm",
            label: "Warm",
            descriptor: "Warm and easy",
            names: ["Kit", "Remy", "Wren", "Milo", "Fenn", "Cleo"]
        ),
        PersonalityGroup(
            id: "energetic",
            label: "Energetic",
            descriptor: "Fast and direct",
            names: ["Nova", "Ember", "Cade", "Lark", "Vela", "Ziggy"]
        ),
        PersonalityGroup(
            id: "poetic",
            label: "Poetic",
            descriptor: "Quiet and observant",
            names: ["Luna", "Iris", "Vesper", "Lyra", "Juno", "Ada"]
        ),
    ]

    /// The default personality group identifier.
    public static let defaultGroupID = "grounded"

    /// All assistant names across every personality group.
    public static var allNames: [String] {
        allGroups.flatMap(\.names)
    }

    /// Returns the personality group that contains the given name, or `nil`.
    public static func groupForName(_ name: String) -> PersonalityGroup? {
        allGroups.first { $0.names.contains(name) }
    }
}
