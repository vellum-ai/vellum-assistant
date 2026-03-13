import AppKit

struct PresetAvatar: Identifiable, Equatable {
    let name: String
    let bodyShape: AvatarBodyShape
    let eyeStyle: AvatarEyeStyle
    let color: AvatarColor

    var id: String { name }

    var image: NSImage? {
        AvatarCompositor.render(bodyShape: bodyShape, eyeStyle: eyeStyle, color: color)
    }

    private static let presets: [PresetAvatar] = [
        PresetAvatar(name: "green-grump", bodyShape: .blob, eyeStyle: .grumpy, color: .green), // color-literal-ok
        PresetAvatar(name: "orange-cloud", bodyShape: .cloud, eyeStyle: .angry, color: .orange), // color-literal-ok
        PresetAvatar(name: "orange-sprout", bodyShape: .sprout, eyeStyle: .curious, color: .orange), // color-literal-ok
        PresetAvatar(name: "orange-star", bodyShape: .star, eyeStyle: .goofy, color: .orange), // color-literal-ok
        PresetAvatar(name: "pink-ghost", bodyShape: .ghost, eyeStyle: .surprised, color: .pink),
        PresetAvatar(name: "pink-spiky", bodyShape: .urchin, eyeStyle: .bashful, color: .pink),
        PresetAvatar(name: "purple-blob", bodyShape: .stack, eyeStyle: .gentle, color: .purple),
        PresetAvatar(name: "purple-flower", bodyShape: .flower, eyeStyle: .quirky, color: .purple),
        PresetAvatar(name: "teal-spike", bodyShape: .burst, eyeStyle: .dazed, color: .teal),
        PresetAvatar(name: "yellow-ninja", bodyShape: .ninja, eyeStyle: .angry, color: .yellow), // color-literal-ok
    ]

    static let all: [PresetAvatar] = presets
    static func random() -> PresetAvatar { all.randomElement()! }
}
