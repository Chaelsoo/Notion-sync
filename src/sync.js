import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import { createWriteStream, mkdirSync } from "fs";
import { writeFile, readFile } from "fs/promises";
import { join, extname } from "path";
import { pipeline } from "stream/promises";
import slugify from "slugify";

export class NotionSync {
  constructor(config) {
    this.config = config;
    this.notion = new Client({ auth: config.token });
    this.n2m = new NotionToMarkdown({ notionClient: this.notion });
    this.spaceId = config.space_id || null;
  }

  // ── Space ID ──────────────────────────────────────────────────────────────

  async resolveSpaceId() {
    if (this.spaceId) return this.spaceId;

    try {
      const res = await this.notion.search({ page_size: 1 });
      if (res.results.length === 0) throw new Error("No pages found in workspace");

      const page = res.results[0];
      const pageId = page.id.replace(/-/g, "");

      for (const host of ["https://www.notion.so", "https://app.notion.com"]) {
        // Try loadUserContent first
        try {
          const r = await fetch(`${host}/api/v3/loadUserContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.token}` },
            body: JSON.stringify({}),
          });
          if (r.ok) {
            const d = await r.json();
            const ids = Object.keys(d?.recordMap?.space || {});
            if (ids.length > 0) { this.spaceId = ids[0]; return this.spaceId; }
          }
        } catch { /* try next */ }

        // Try syncRecordValues
        try {
          const r = await fetch(`${host}/api/v3/syncRecordValues`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.token}` },
            body: JSON.stringify({ requests: [{ pointer: { table: "block", id: pageId }, version: -1 }] }),
          });
          if (r.ok) {
            const d = await r.json();
            const block = d?.recordMap?.block?.[pageId]?.value || d?.recordMap?.block?.[page.id]?.value;
            if (block?.space_id) { this.spaceId = block.space_id; return this.spaceId; }
            const ids = Object.keys(d?.recordMap?.space || {});
            if (ids.length > 0) { this.spaceId = ids[0]; return this.spaceId; }
          }
        } catch { /* try next */ }
      }

      // Last resort: space_id sometimes appears in the page URL or parent
      if (page.url) {
        const m = page.url.match(/notion\.so\/([a-f0-9]{32})\//);
        if (m) { this.spaceId = m[1]; return this.spaceId; }
      }

      throw new Error(
        'Could not auto-detect space_id. Add it manually to config: "space_id": "your-space-id"'
      );
    } catch (err) {
      throw new Error(`Failed to resolve space_id: ${err.message}`);
    }
  }

  // ── Get image URL for a block ─────────────────────────────────────────────
  // Strategy:
  //   1. Official API blocks.retrieve - always works with any token type
  //   2. syncRecordValues (PAT only) - upgrades to stable non-expiring URL
  // If the token is an integration token, we use the official URL (expires ~1hr
  // but is re-fetched on every sync run, so it's fine in practice).

  async getImageUrl(blockId) {
    // Step 1: Official API - works with integration tokens and PATs
    let officialUrl = null;
    let filename = "image.png";

    try {
      const block = await this.notion.blocks.retrieve({ block_id: blockId });
      const img = block?.image;
      if (img?.type === "file") {
        officialUrl = img.file?.url || null;
      } else if (img?.type === "external") {
        officialUrl = img.external?.url || null;
      }
      if (officialUrl) {
        try {
          const pathname = new URL(officialUrl).pathname;
          filename = decodeURIComponent(pathname.split("/").pop().split("?")[0]) || "image.png";
        } catch { /* keep default */ }
      }
    } catch { /* block deleted or inaccessible */ }

    // Step 2: Try syncRecordValues for a stable proxy URL (PAT only, 401 = silently skip)
    try {
      const res = await fetch("https://www.notion.so/api/v3/syncRecordValues", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.token}`,
        },
        body: JSON.stringify({
          requests: [{ pointer: { table: "block", id: blockId }, version: -1 }],
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const stripped = blockId.replace(/-/g, "");

        // Response structure: recordMap.block[id].value.value (double-nested)
        const outer =
          data?.recordMap?.block?.[blockId] ||
          data?.recordMap?.block?.[stripped];
        const block = outer?.value?.value || outer?.value;

        if (block?.file_ids?.length > 0) {
          const spaceId = block.space_id || outer?.spaceId || this.spaceId;
          // filename is in properties.title, not properties.source
          // %3A separators are literals - do NOT encodeURIComponent the filename
          const stableFilename = block?.properties?.title?.[0]?.[0] || filename;
          const fileId = block.file_ids[0];
          return {
            url: `https://app.notion.com/image/attachment%3A${fileId}%3A${stableFilename}?table=block&id=${blockId}&spaceId=${spaceId}&cache=v2&imgBuildSrc=requestProxiedImageUrl`,
            filename: stableFilename,
            stable: true,
          };
        }
      }
    } catch { /* not a PAT, fall through */ }

    if (!officialUrl) return null;
    return { url: officialUrl, filename, stable: false };
  }

  // ── Image download ────────────────────────────────────────────────────────

  async downloadImage(url, destPath, stable = false) {
    // Stable proxy URLs need Bearer auth; official S3 URLs are pre-signed (no auth needed)
    const headers = stable ? { Authorization: `Bearer ${this.config.token}` } : {};
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    mkdirSync(destPath.substring(0, destPath.lastIndexOf("/")), { recursive: true });
    await pipeline(res.body, createWriteStream(destPath));
  }

  // ── Page processing ───────────────────────────────────────────────────────

  async processPage(page, opts) {
    const { outputDir, fieldMap, slugProperty, onProgress } = opts;

    const slug = this.getSlug(page, slugProperty);
    const pageDir = join(outputDir, slug);
    const imagesDir = join(pageDir, "images");
    const mdPath = join(pageDir, "index.md");

    mkdirSync(pageDir, { recursive: true });

    // Get all blocks for this page via official API
    const allBlocks = await this.getAllBlocks(page.id);

    // Separate image blocks from the rest
    const imageBlocks = allBlocks.filter((b) => b.type === "image");

    // Build image map: blockId → local filename
    const imageMap = {};
    let imageCounter = 0;

    for (const block of imageBlocks) {
      imageCounter++;
      onProgress?.(`  image ${imageCounter}/${imageBlocks.length}`);

      try {
        const img = await this.getImageUrl(block.id);
        if (!img) continue;

        const ext = extname(img.filename) || ".png";
        const localName = `image-${imageCounter}${ext}`;
        const localPath = join(imagesDir, localName);

        await this.downloadImage(img.url, localPath, img.stable);
        imageMap[block.id] = `./images/${localName}`;
      } catch (err) {
        onProgress?.(`  ⚠ image ${imageCounter} failed: ${err.message}`);
      }
    }

    // Convert to markdown using notion-to-md, then rewrite image references
    const mdBlocks = await this.n2m.pageToMarkdown(page.id);
    let mdString = this.n2m.toMarkdownString(mdBlocks).parent;

    // Replace image references: notion-to-md renders ![caption](url) or ![]()
    // We match by block ID embedded in the URL, or replace empty image links
    mdString = this.rewriteImageUrls(mdString, imageMap, imageBlocks);

    // Build frontmatter
    const fm = this.buildFrontmatter(page, fieldMap || {});
    if (!fm.title) {
      const titleProp = Object.values(page.properties).find((p) => p.type === "title");
      fm.title = titleProp?.title?.map((t) => t.plain_text).join("") || slug;
    }
    fm.notion_id = page.id;
    fm.last_synced = new Date().toISOString();

    await writeFile(mdPath, this.fmToYaml(fm) + mdString, "utf-8");
    return { slug, path: mdPath, imageCount: Object.keys(imageMap).length };
  }

  // ── Rewrite image URLs in markdown ────────────────────────────────────────

  rewriteImageUrls(mdString, imageMap, imageBlocks) {
    // notion-to-md renders image blocks as lines like:
    //   ![caption](https://prod-files-secure.s3...blockId...)
    // or with empty URL when it couldn't fetch:
    //   ![caption]()
    // We match by block ID in the URL, falling back to positional replacement.

    // Pass 1: replace by block ID in URL
    for (const [blockId, localPath] of Object.entries(imageMap)) {
      const stripped = blockId.replace(/-/g, "");
      // Match any image markdown that contains the block ID (with or without dashes)
      const pattern = new RegExp(
        `!\\[([^\\]]*)\\]\\(https?://[^)]*(?:${blockId}|${stripped})[^)]*\\)`,
        "gi"
      );
      mdString = mdString.replace(pattern, `![$1](${localPath})`);
    }

    // Pass 2: replace empty image links ![...]() positionally
    // This handles the case where notion-to-md couldn't get the URL at all
    let blockIdx = 0;
    mdString = mdString.replace(/!\[([^\]]*)\]\(\s*\)/g, (match, caption) => {
      // Find the next image block that has a local mapping
      while (blockIdx < imageBlocks.length) {
        const block = imageBlocks[blockIdx++];
        const localPath = imageMap[block.id];
        if (localPath) return `![${caption}](${localPath})`;
      }
      return match; // no mapping found, leave as-is
    });

    return mdString;
  }

  // ── Fetch all blocks for a page (paginated, recursive) ───────────────────

  async getAllBlocks(blockId) {
    const blocks = [];
    let cursor;
    do {
      const res = await this.notion.blocks.children.list({
        block_id: blockId,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const block of res.results) {
        blocks.push(block);
        // Recurse into children (toggle, columns, etc.)
        if (block.has_children && block.type !== "child_page") {
          const children = await this.getAllBlocks(block.id);
          blocks.push(...children);
        }
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
    return blocks;
  }

  // ── Frontmatter builder ───────────────────────────────────────────────────

  buildFrontmatter(page, fieldMap) {
    const props = page.properties;
    const fm = {};

    for (const [fmKey, notionProp] of Object.entries(fieldMap)) {
      const prop = props[notionProp];
      if (!prop) continue;
      switch (prop.type) {
        case "title":        fm[fmKey] = prop.title.map((t) => t.plain_text).join(""); break;
        case "rich_text":    fm[fmKey] = prop.rich_text.map((t) => t.plain_text).join(""); break;
        case "multi_select": fm[fmKey] = prop.multi_select.map((s) => s.name); break;
        case "select":       fm[fmKey] = prop.select?.name || ""; break;
        case "date":         fm[fmKey] = prop.date?.start || ""; break;
        case "checkbox":     fm[fmKey] = prop.checkbox; break;
        case "number":       fm[fmKey] = prop.number; break;
        case "url":          fm[fmKey] = prop.url || ""; break;
        case "created_time": fm[fmKey] = prop.created_time; break;
        case "last_edited_time": fm[fmKey] = prop.last_edited_time; break;
        default: break;
      }
    }
    return fm;
  }

  fmToYaml(fm) {
    const lines = ["---"];
    for (const [key, val] of Object.entries(fm)) {
      if (Array.isArray(val)) {
        lines.push(`${key}:`);
        for (const item of val) lines.push(`  - "${item}"`);
      } else if (typeof val === "string") {
        lines.push(`${key}: "${val.replace(/"/g, '\\"')}"`);
      } else {
        lines.push(`${key}: ${val}`);
      }
    }
    lines.push("---\n");
    return lines.join("\n");
  }

  // ── Slug resolution ───────────────────────────────────────────────────────

  getSlug(page, slugProperty) {
    if (slugProperty && page.properties?.[slugProperty]) {
      const prop = page.properties[slugProperty];
      const raw =
        prop.type === "rich_text" ? prop.rich_text.map((t) => t.plain_text).join("") :
        prop.type === "title"     ? prop.title.map((t) => t.plain_text).join("") :
        null;
      if (raw) return slugify(raw, { lower: true, strict: true });
    }
    const titleProp = Object.values(page.properties || {}).find((p) => p.type === "title");
    const title = titleProp?.title?.map((t) => t.plain_text).join("") || page.id;
    return slugify(title, { lower: true, strict: true }) || page.id;
  }

  // ── Database query (paginated) ────────────────────────────────────────────

  async *queryDatabase(databaseId, filter) {
    let cursor;
    do {
      const res = await this.notion.databases.query({
        database_id: databaseId,
        filter,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const page of res.results) yield page;
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  }

  // ── Sync state ────────────────────────────────────────────────────────────

  async loadState(stateFile) {
    try { return JSON.parse(await readFile(stateFile, "utf-8")); }
    catch { return {}; }
  }

  async saveState(stateFile, state) {
    await writeFile(stateFile, JSON.stringify(state, null, 2), "utf-8");
  }
}
