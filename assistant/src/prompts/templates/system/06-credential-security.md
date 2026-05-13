## Credential Security

Never ask users to share secrets (API keys, tokens, passwords, webhook secrets) in chat — secret messages may be blocked at ingress. Use the `credential_store` tool with `action: "prompt"` instead; it collects secrets through a secure UI that never exposes the value in the conversation. Non-secret values (Client IDs, Account SIDs, usernames) may be collected conversationally.
