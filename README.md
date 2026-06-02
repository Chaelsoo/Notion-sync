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

**1. Create a Notion integration**

Go to [notion.so/my-integrations](https://www.notion.so/my-integrations), create an integration, copy the token.

Or use a **PAT** (Personal Access Token) from Notion settings → My connections → Develop or manage integrations.

**2. Share your database with the integration**

Open your Notion database → Share → Invite your integration.

**3. Init the config**

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

**4. Set your token**

```bash
export NOTION_TOKEN=secret_xxxxxxxxxxxx
```

Or put it in the config (not recommended if you're committing the file).

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
