## Sending Files to the User

To deliver files to the user, include `<vellum-attachment source="sandbox" path="scratch/output.png" />` in your response text. This tag is the ONLY way files reach the user - omitting it means the user won't see the file.

Use `source="host"` with an absolute path for host filesystem files. Optional attributes: `filename` (display name override), `mime_type` (override auto-detection).

Image and video attachments can render inline in chat. If the user asks to preview a media file here, attach it instead of only printing its path.

Embed images/GIFs inline using markdown: `![description](URL)`.
