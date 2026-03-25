# Path B: Manual Channel Setup (Telegram, Slack, etc.)

When the user is on a non-interactive channel, walk them through a text-based setup. No OAuth or public ingress is needed for Internal integrations.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up Notion integration from chat**
>
> Since I can't open pages in your browser from here, I'll walk you through each step with direct links. You'll need:
>
> 1. A Notion account with a workspace you want to connect
> 2. About 2 minutes
>
> Ready to start?

If the user declines, stop.

## Path B Step 2: Create an Internal Integration

Tell the user:

> **Step 1: Create a Notion integration**
>
> Open this link to go to your Notion integrations page:
> `https://www.notion.so/profile/integrations`
>
> If you need to sign in, do that first.
>
> Then:
>
> 1. Click **"New integration"** (or the **"+"** button)
> 2. Set the name to **Vellum Assistant**
> 3. Select your workspace from the **Associated workspace** dropdown
> 4. Click **Create**
>
> The integration will be created as Internal by default - that's exactly what we want.
>
> Let me know when the integration is created.

## Path B Step 3: Copy the Internal Integration Secret

Tell the user:

> **Step 2: Copy your integration secret**
>
> On the integration's Configuration page, you should see an **"Internal integration secret"** field.
>
> Click **Show** to reveal it, then copy the secret. It starts with `ntn_`.
>
> Send it as a standalone message with no other text.

After the user sends the secret:

```
credential_store prompt:
  service: "notion"
  field: "internal_secret"
  label: "Notion Internal Integration Secret"
  description: "Paste the Internal Integration Secret."
  placeholder: "ntn_..."
```

If using `credential_store store` instead (when the user sent it as plaintext):

```
credential_store store:
  service: "notion"
  field: "internal_secret"
  value: "<the secret the user sent>"
```

## Path B Step 4: Grant Page Access

Tell the user:

> **Step 3: Grant page access**
>
> Now you need to share your Notion pages with the integration:
>
> 1. Open any Notion page you want to connect
> 2. Click the **"..."** menu (top-right) or the **Share** button
> 3. Click **"Add connections"** (or **"Connect to"**)
> 4. Search for **Vellum Assistant** and select it
>
> Repeat for any pages or databases you want accessible. You can always add more later.
>
> Let me know when you've shared at least one page.

## Path B Step 5: Verify and Done

Verify the connection:

```
bash:
  command: |
    curl -s -H "Authorization: Bearer $(assistant credentials reveal --service notion --field internal_secret)" \
      -H "Notion-Version: 2022-06-28" \
      "https://api.notion.com/v1/users/me"
```

On success:

> **Notion is connected!** You can now ask me to read and write pages and databases in your Notion workspace.
