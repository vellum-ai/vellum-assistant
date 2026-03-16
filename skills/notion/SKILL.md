---
name: notion
description: Read and write Notion pages and databases using the Notion API
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📝"
  vellum:
    display-name: "Notion"
---

You have access to the Notion API via the stored Internal Integration Secret for `integration:notion`.

## Authentication

The Notion integration secret is stored securely via `credential_store`. To make authenticated API calls, inject the secret into the Authorization header using `assistant credentials reveal`.

**Step 1 — Check for credentials:**

```
credential_store action=list
```

Find the entry with `service: "integration:notion"` and `field: "internal_secret"`.

If no such entry exists, tell the user: "Notion is not connected yet. Load the **notion-oauth-setup** skill to set it up first."

**Step 2 — Make authenticated API calls:**

Use `bash` with `assistant credentials reveal` to inject the secret into the Authorization header:

```
bash:
  command: |
    curl -s -X POST https://api.notion.com/v1/search \
      -H "Authorization: Bearer $(assistant credentials reveal --service integration:notion --field internal_secret)" \
      -H "Notion-Version: 2022-06-28" \
      -H "Content-Type: application/json" \
      -d '{}'
```

All Notion API calls go to `https://api.notion.com/v1/`. Always include the `Notion-Version: 2022-06-28` header.

## Reading Pages

### Get a page by ID

```
GET https://api.notion.com/v1/pages/{page_id}
```

Returns page properties. Use the page ID from a Notion URL — the last segment of the URL, e.g. for `https://notion.so/My-Page-abc123def456` the ID is `abc123def456` (formatted as UUID: `abc123de-f456-...`).

### Get page content (blocks)

```
GET https://api.notion.com/v1/blocks/{block_id}/children?page_size=100
```

Pages are blocks too — use the page ID as the `block_id`. Iterates through the page's child blocks. Use `start_cursor` for pagination when `has_more` is `true`.

**Block types and how to render them:**

- `paragraph`: Read `paragraph.rich_text[].plain_text`
- `heading_1`, `heading_2`, `heading_3`: Read `heading_N.rich_text[].plain_text`
- `bulleted_list_item`, `numbered_list_item`: Read `*.rich_text[].plain_text`
- `to_do`: Read `to_do.rich_text[].plain_text` and `to_do.checked`
- `toggle`: Read `toggle.rich_text[].plain_text`; children are nested blocks
- `code`: Read `code.rich_text[].plain_text` and `code.language`
- `quote`: Read `quote.rich_text[].plain_text`
- `callout`: Read `callout.rich_text[].plain_text`
- `divider`: Render as `---`
- `image`: Read `image.external.url` or `image.file.url`
- `child_page`: Read `child_page.title`; use its `id` to recursively fetch if needed

## Searching

### Search pages and databases

```
POST https://api.notion.com/v1/search
{
  "query": "your search term",
  "filter": { "value": "page", "property": "object" },
  "sort": { "direction": "descending", "timestamp": "last_edited_time" },
  "page_size": 10
}
```

Omit `filter` to search both pages and databases. Use `filter.value: "database"` to search only databases.

Returns `results[]` with `id`, `url`, `properties.title` (for pages), and `title[]` (for databases).

## Reading Databases

### Get database metadata

```
GET https://api.notion.com/v1/databases/{database_id}
```

Returns the database schema (all property definitions).

### Query a database

```
POST https://api.notion.com/v1/databases/{database_id}/query
{
  "filter": {
    "property": "Status",
    "select": { "equals": "In Progress" }
  },
  "sorts": [
    { "property": "Created", "direction": "descending" }
  ],
  "page_size": 20
}
```

Omit `filter` to retrieve all rows. Returns `results[]` where each item is a page (database row).

**Extracting property values from database rows:**

- `title`: `properties.Name.title[].plain_text`
- `rich_text`: `properties.Notes.rich_text[].plain_text`
- `number`: `properties.Price.number`
- `select`: `properties.Status.select.name`
- `multi_select`: `properties.Tags.multi_select[].name`
- `date`: `properties.Due.date.start` (ISO 8601)
- `checkbox`: `properties.Done.checkbox`
- `url`: `properties.Link.url`
- `email`: `properties.Email.email`
- `people`: `properties.Owner.people[].name`
- `relation`: `properties.Projects.relation[].id` (array of page IDs)

## Creating Pages

### Create a new page

```
POST https://api.notion.com/v1/pages
{
  "parent": { "page_id": "<parent_page_id>" },
  "properties": {
    "title": {
      "title": [{ "text": { "content": "My New Page" } }]
    }
  },
  "children": [
    {
      "object": "block",
      "type": "paragraph",
      "paragraph": {
        "rich_text": [{ "text": { "content": "Page content here." } }]
      }
    }
  ]
}
```

For database rows, use `"parent": { "database_id": "<database_id>" }` and include the database's required properties.

## Updating Pages

### Update page properties

```
PATCH https://api.notion.com/v1/pages/{page_id}
{
  "properties": {
    "Status": { "select": { "name": "Done" } },
    "Due": { "date": { "start": "2024-12-31" } }
  }
}
```

### Append blocks to a page

```
PATCH https://api.notion.com/v1/blocks/{block_id}/children
{
  "children": [
    {
      "object": "block",
      "type": "paragraph",
      "paragraph": {
        "rich_text": [{ "text": { "content": "Appended content." } }]
      }
    },
    {
      "object": "block",
      "type": "heading_2",
      "heading_2": {
        "rich_text": [{ "text": { "content": "A heading" } }]
      }
    },
    {
      "object": "block",
      "type": "bulleted_list_item",
      "bulleted_list_item": {
        "rich_text": [{ "text": { "content": "A bullet point" } }]
      }
    },
    {
      "object": "block",
      "type": "to_do",
      "to_do": {
        "rich_text": [{ "text": { "content": "A task" } }],
        "checked": false
      }
    }
  ]
}
```

### Update a block's content

```
PATCH https://api.notion.com/v1/blocks/{block_id}
{
  "paragraph": {
    "rich_text": [{ "text": { "content": "Updated text." } }]
  }
}
```

### Delete (archive) a block

```
DELETE https://api.notion.com/v1/blocks/{block_id}
```

## Archive / Delete Pages

Notion does not permanently delete pages via the API — it archives them:

```
PATCH https://api.notion.com/v1/pages/{page_id}
{
  "archived": true
}
```

## Pagination

When a response includes `"has_more": true`, pass `"start_cursor": response.next_cursor` in the next request to get the next page of results.

## Error Handling

- **401 Unauthorized**: The integration secret is missing or invalid. Ask the user to re-run the **notion-oauth-setup** skill to update the secret.
- **403 Forbidden**: The integration doesn't have access to the requested page or database. Remind the user that they need to share the page/database with the "Vellum Assistant" integration in Notion (via the Share menu → "Add connections").
- **404 Not Found**: The page or database ID doesn't exist or the integration can't see it. Verify the ID and check sharing settings.
- **400 Bad Request**: Check the request body structure. The Notion API error response includes a `message` field with details.
- **429 Too Many Requests**: Wait a few seconds and retry.

## Tips

- Notion page IDs in URLs are formatted without hyphens. The API accepts both forms: `abc123def456...` or `abc123de-f456-...`.
- When extracting IDs from Notion URLs, strip any query parameters and trailing path components after the 32-character ID segment.
- Always include `Notion-Version: 2022-06-28` header to get stable API behavior.
- For rich text, concatenate all `plain_text` values in the array to get the full text content.
- When creating content with rich text formatting (bold, italic, links), use the `annotations` and `href` fields in rich_text objects.
