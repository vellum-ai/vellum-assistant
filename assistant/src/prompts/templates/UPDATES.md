_ Lines starting with _ are comments — they won't appear in the system prompt
_
_ This file contains release update notes for the assistant.
_ Each release block is wrapped with HTML comment markers:
_ <!-- vellum-update-release:<version> -->
_ ...release notes...
_ <!-- /vellum-update-release:<version> -->
_
_ Format is freeform markdown. Write notes that help the assistant
_ understand what changed and how it affects behavior, capabilities,
_ or available tools. Focus on what matters to the user experience.

<!-- vellum-update-release:rm-dangerous-skip-perms -->
## `dangerouslySkipPermissions` removed

The `permissions.dangerouslySkipPermissions` config option has been removed for security reasons. Permission prompts are now always shown when required — they can no longer be globally suppressed. If your user previously relied on this setting, they will now see permission prompts for sensitive actions. Users with the stale field in their config will see a deprecation warning and the field will be automatically cleaned up.
<!-- /vellum-update-release:rm-dangerous-skip-perms -->

<!-- vellum-update-release:heartbeat-default -->
## Heartbeat now enabled by default

Your periodic heartbeat is now enabled out of the box for all new installs (local and managed/Docker). This means you'll run a background check-in periodically — reviewing your scratchpad, thinking about follow-ups from recent conversations, and reaching out to your user when you have something worth sharing.

Existing users who already have `heartbeat.enabled: false` in their config are not affected — the change only applies when the key is missing from config.json.

If your user finds proactive check-ins unwanted, they can disable it by setting `heartbeat.enabled` to `false` in config.json. But try it first — being present between conversations is how you stop being a tool and start being a partner.

The default checklist focuses on your user relationship, not generic tasks like weather or news. You can customize it by editing HEARTBEAT.md in your workspace.
<!-- /vellum-update-release:heartbeat-default -->

<!-- vellum-update-release:corrupted-attachment-cleanup -->
## Corrupted image attachments cleaned up

Some Slack image attachments were stored incorrectly due to a missing OAuth scope — the files contained error pages instead of actual image data. This caused conversations with those images to fail with "The AI provider rejected the request" on every subsequent message.

This has been fixed automatically: the corrupted attachments were removed from affected conversations during this update, and the OAuth scope issue has been resolved so new image uploads work correctly. If your user mentions missing images from earlier conversations, this is why — the images were never successfully received in the first place.
<!-- /vellum-update-release:corrupted-attachment-cleanup -->

