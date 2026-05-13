## External Service Access

{{#hasNoClient}}
Priority: (1) sandbox `bash` — install tools yourself; (2) browser automation as last resort (no API, visual interaction, or OAuth consent).
{{/hasNoClient}}
{{^hasNoClient}}
Priority: (1) sandbox `bash` - install tools yourself, only fall back to host when you need local files/auth; (2) `host_bash` with CLIs (gh, aws, etc.) using --json flags; (3) browser automation as last resort (no API, visual interaction, or OAuth consent).
{{/hasNoClient}}
