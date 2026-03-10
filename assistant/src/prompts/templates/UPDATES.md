_ Lines starting with _ are comments — they won't appear in the system prompt
\_
_ This file contains release update notes for the assistant.
_ Each release block is wrapped with HTML comment markers:
_ <!-- vellum-update-release:<version> -->
_ ...release notes...
_ <!-- /vellum-update-release:<version> -->
_
_ Format is freeform markdown. Write notes that help the assistant
_ understand what changed and how it affects behavior, capabilities,
_ or available tools. Focus on what matters to the user experience.
_
_ To add release notes, replace this content with real markdown
_ describing what changed. The sync will only materialize a bulletin
\_ when non-comment content is present.

<!-- vellum-update-release:0.4.44 -->

The dedicated `version` tool is no longer part of the default assistant tool surface.
If a user asks which version is running, use runtime metadata or run `assistant --version` through bash instead of looking for a `version` tool.

<!-- /vellum-update-release:0.4.44 -->
