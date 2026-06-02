# Notion-sync

Pull and sync Notion database pages as local Markdown files - images included.

```
output/
  my-writeup/
    index.md       ← clean markdown with frontmatter
    images/
      image-1.png  ← downloaded locally, URLs rewritten
      image-2.png
  another-page/
    index.md
    ...
```

Use the output however you want: Astro, Hugo, Obsidian, plain files, whatever.

---

## Install

```bash
npm install -g notion-sync
# or run without installing:
npx notion-sync <command>
```

## Setup

**1. Get a token**

Notion-sync works best with a **Personal Access Token (PAT)**:

1. Go to [notion.so/profile/personal-access-tokens](https://www.notion.so/profile/personal-access-tokens)
2. Click **New personal access token**
3. Give it a name, select your workspace, and enable the capabilities you need (at minimum: read content)
4. Copy the token - it starts with `ntn_`

> Alternatively, use an integration token from [notion.so/profile/integrations](https://www.notion.so/profile/integrations). Images will still work but URLs expire after ~1 hour and are refreshed on each sync run.

**2. Add the token to your .env**

```bash
NOTION_TOKEN=ntn_xxxxxxxxxxxx
```

**3. Share your content with the token**

For PATs: the token automatically has access to everything you can access in Notion.

For integration tokens: open each database or page you want to sync, click `...`, **Add connections**, and select your integration.

**4. Init the config**

```bash
notion-sync init
```

Edit the generated `notion-sync.config.json`:

```json
{
  "database_id": "your-database-id",
  "output_dir": "./output",
  "slug_property": null,
  "frontmatter": {
    "title": "Name",
    "tags": "Tags",
    "date": "Date",
    "status": "Status"
  }
}
```

---

## Commands

### `notion-sync pull`

Pull all pages from the database. Only re-syncs pages that changed since the last run.

```bash
notion-sync pull
notion-sync pull --force          # ignore sync state, re-sync everything
notion-sync pull --page <id>      # single page by Notion page ID
notion-sync pull --dry-run        # preview without writing
notion-sync pull --config ./custom.config.json
```

### `notion-sync watch`

Poll Notion every N seconds and auto-sync on changes.

```bash
notion-sync watch
notion-sync watch --interval 30   # poll every 30s (default: 60)
```

### `notion-sync status`

Show which pages were synced and when.

```bash
notion-sync status
```

### `notion-sync init`

Generate a starter config file.

---

## Config reference

| Field | Type | Description |
|---|---|---|
| `token` | string | Notion integration token. Prefer `NOTION_TOKEN` env var. |
| `database_id` | string | ID of the Notion database to sync. |
| `output_dir` | string | Where to write output. Default: `./output` |
| `slug_property` | string \| null | Notion property to use as the folder slug. `null` = auto from title. |
| `frontmatter` | object | Map of `frontmatter_key → NotionPropertyName`. |
| `space_id` | string | Optional. Auto-detected if omitted. Or set `NOTION_SPACE_ID`. |

### Supported property types for frontmatter

`title`, `rich_text`, `select`, `multi_select`, `date`, `checkbox`, `number`, `url`, `created_time`, `last_edited_time`

### Auto-added frontmatter fields

These are always added regardless of your mapping:

```yaml
notion_id: "abc123..."      # Notion page ID
last_synced: "2026-06-01T..." # when this page was last pulled
```

---

## Image handling

Notion's official API returns signed S3 URLs for images that expire in ~1 hour, making them useless for static sites.

`notion-sync` works around this by using Notion's internal `syncRecordValues` endpoint (`app.notion.com`) to get stable file IDs, then downloads images through the image proxy with your bearer token. Images are saved locally and markdown URLs are rewritten to relative paths.

> **Note:** `syncRecordValues` is an undocumented internal API. It's been stable for years and widely used by community tools, but Notion could change it without notice.

---

## Sync state

A `.notion-sync-state.json` file is created in the current directory tracking the last sync time per page. Add it to `.gitignore` or commit it - your call.

---

## Example: Astro integration

```bash
notion-sync pull --config notion-sync.config.json
# then copy output to your content dir:
cp -r output/* src/content/blog/
```

Or wire it into your build script:

```json
{
  "scripts": {
    "prebuild": "notion-sync pull",
    "build": "astro build"
  }
}
```

---

## License

MIT
