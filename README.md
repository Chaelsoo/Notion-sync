# Notion-sync

Pull Notion database pages as local Markdown files — images included, reliably.

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

## How it works

Notion's official API returns image blocks like this for any image uploaded before a certain point:

```json
{ "image": { "caption": [] } }
```

No URL. No file reference. Nothing. Every existing Notion-to-markdown tool hits this and either skips the images silently or errors out.

After digging into how the Notion web app actually loads images, we found that the internal `syncRecordValues` endpoint returns the full block record including `file_ids` and `space_id`. Combined with the `app.notion.com/image/` proxy and Bearer token auth, you can download any image reliably — no S3 expiry, no empty responses.

That's the core insight this tool is built on.

> **Note:** `syncRecordValues` is an undocumented internal endpoint. It has been stable for years and is widely used by community tools, but Notion could change it without notice.

---

## Install

```bash
npm install -g notion-sync-cli
```

Or run without installing:

```bash
npx notion-sync-cli init
```

After global install, use it as `notion-sync` from anywhere.

---

## Setup

### 1. Get a token

notion-sync works best with a **Personal Access Token (PAT)**:

1. Go to [notion.so/profile/personal-access-tokens](https://www.notion.so/profile/personal-access-tokens)
2. Click **New personal access token**
3. Give it a name, select your workspace, and enable read content at minimum
4. Copy the token — it starts with `ntn_`

> **PAT is strongly recommended.** Integration tokens hit a known Notion API bug where image blocks return empty responses for older uploads — the `syncRecordValues` workaround only works reliably with a PAT.

### 2. Add the token to your .env

```
NOTION_TOKEN=ntn_xxxxxxxxxxxx
```

### 3. Share your content with the token

For PATs: the token automatically has access to everything you can access in Notion.

For integration tokens: open each database or page, click `...`, **Add connections**, and select your integration.

### 4. Init the config

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
notion-sync pull --force             # ignore sync state, re-sync everything
notion-sync pull --page <id>         # single page by Notion page ID
notion-sync pull --dry-run           # preview without writing
notion-sync pull --config ./custom.config.json
```

### `notion-sync watch`

Poll Notion every N seconds and auto-sync on changes.

```bash
notion-sync watch
notion-sync watch --interval 30      # poll every 30s (default: 60)
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

| Field           | Type           | Description                                                          |
| --------------- | -------------- | -------------------------------------------------------------------- |
| `token`         | string         | Notion token. Prefer `NOTION_TOKEN` env var.                         |
| `database_id`   | string         | ID of the Notion database to sync.                                   |
| `output_dir`    | string         | Where to write output. Default: `./output`                           |
| `slug_property` | string / null  | Notion property to use as the folder slug. `null` = auto from title. |
| `frontmatter`   | object         | Map of `frontmatter_key → NotionPropertyName`.                       |
| `space_id`      | string         | Optional. Auto-detected if omitted. Or set `NOTION_SPACE_ID`.        |

### Supported property types for frontmatter

`title`, `rich_text`, `select`, `multi_select`, `date`, `checkbox`, `number`, `url`, `created_time`, `last_edited_time`

### Auto-added frontmatter fields

These are always added regardless of your mapping:

```yaml
notion_id: "abc123..."         # Notion page ID
last_synced: "2026-06-01T..."  # when this page was last pulled
```

---

## Image handling

Notion's official API returns signed S3 URLs for images that expire in about an hour, making them useless for static sites and long-running pipelines.

notion-sync works around this using two undocumented but stable mechanisms:

1. **`syncRecordValues`** — Notion's internal sync endpoint returns the full block record, including `file_ids`, `space_id`, and the original filename. These don't appear in the public API response at all.

2. **Image proxy** — `app.notion.com/image/` serves images by block ID and file ID with Bearer token auth. No S3 URL needed, no expiry.

The result: images are downloaded locally and markdown URLs are rewritten to relative paths. Works on images uploaded years ago that every other tool silently skips.

---

## Sync state

A `.notion-sync-state.json` file tracks the last sync time per page. Add it to `.gitignore` or commit it depending on your workflow.

---

## Example: Astro integration

```bash
notion-sync pull --config notion-sync.config.json
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
