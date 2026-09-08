import Intents
import UserNotifications

/// Rewrite `content` as a Communication Notification: the assistant's avatar in
/// a circle with the app icon badged into its corner, the assistant's name on
/// line one, the conversation title on line two, the body unchanged.
///
/// iOS grants that treatment only to a notification updated from a donated
/// `INSendMessageIntent`, which is why the intent is donated before the content
/// is rewritten. `updating(from:)` copies the sender, image, and thread onto the
/// content and leaves `userInfo`, `categoryIdentifier`, and the body alone, so
/// tap routing is unaffected.
///
/// The intent is built the way `clients/macos/native/notifier/notifier.mm`
/// builds its own, so one assistant looks and threads the same on both
/// platforms: the sender id is the thread, "me" is a handle rather than an
/// empty person, and `serviceName` is left off.
func communicationContent(
    from content: UNNotificationContent,
    sender: SenderPayload,
    avatar: Data
) async throws -> UNNotificationContent {
    // INImage(url:) reads local files only, so the bytes travel inline.
    let image = INImage(imageData: avatar)
    let senderPerson = INPerson(
        personHandle: INPersonHandle(value: sender.id, type: .unknown),
        nameComponents: nil,
        displayName: sender.name,
        image: image,
        contactIdentifier: nil,
        customIdentifier: sender.id,
        isMe: false,
        suggestionType: .none
    )
    let mePerson = INPerson(
        personHandle: INPersonHandle(value: "me", type: .unknown),
        nameComponents: nil,
        displayName: nil,
        image: nil,
        contactIdentifier: nil,
        customIdentifier: "me",
        isMe: true,
        suggestionType: .none
    )

    // A group conversation is what puts the title on line two, so a titled push
    // becomes a two-recipient group named after the conversation. Its image has
    // to be set explicitly or iOS composes a glyph out of the participants
    // instead of showing the assistant.
    let title = content.title.trimmingCharacters(in: .whitespacesAndNewlines)
    let groupName = title.isEmpty ? nil : INSpeakableString(spokenPhrase: title)

    let intent = INSendMessageIntent(
        recipients: groupName == nil ? [mePerson] : [mePerson, senderPerson],
        outgoingMessageType: .outgoingMessageText,
        content: content.body,
        speakableGroupName: groupName,
        conversationIdentifier: sender.id,
        serviceName: nil,
        sender: senderPerson,
        attachments: nil
    )
    if groupName != nil {
        intent.setImage(image, forParameterNamed: \.speakableGroupName)
    }

    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    try await interaction.donate()
    return try content.updating(from: intent)
}
