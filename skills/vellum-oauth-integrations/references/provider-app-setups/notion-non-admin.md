# Non-Admin Alternatives for Notion Integration Setup

The user doesn't have admin permissions on their Notion workspace. Only workspace admins can create Internal integrations, so the standard Step 2 won't work for them.

Present these options:

1. **Ask a workspace admin to create the integration** — The admin creates an Internal integration named "Vellum Assistant", copies the secret token (`ntn_...`), and shares it with the user. The user can then grant it access to their own pages. This is the easiest path.
2. **Use a different workspace** — If the user has a personal Notion workspace (or any workspace where they're admin), they can set up the integration there instead.
3. **Request admin permissions** — The user can ask their workspace admin to grant them admin access, then retry Step 2.

Suggested message:

> No worries — you don't need to be an admin yourself. The easiest path is to ask a workspace admin to create the integration and send you the secret token. You can then grant it access to your own pages.
>
> Here are your options:
>
> 1. **Ask your admin** to create an Internal integration named "Vellum Assistant" and share the secret token with you
> 2. **Use a different workspace** where you're an admin (e.g., a personal workspace)
> 3. **Request admin access** from your workspace admin, then come back to this step

After the user picks an option, adapt the flow:

- **Option 1 (admin shares token):** When the user has the secret, skip directly to Step 3a (collect the secret via `credential_store prompt`) and then 3b (grant page access on their own pages).
- **Option 2 (different workspace):** Restart from Step 1 targeting the new workspace.
- **Option 3 (request admin access):** Pause the flow. Tell them to come back when they have admin access and you'll pick up where you left off.
