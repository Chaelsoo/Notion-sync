#!/usr/bin/env node

import "dotenv/config";
import { program } from "commander";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { readFile, writeFile } from "fs/promises";
import { mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { Client } from "@notionhq/client";
import { NotionSync } from "./sync.js";

const CONFIG_FILE = "notion-sync.config.json";
const STATE_FILE = ".notion-sync-state.json";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadConfig(configPath) {
  const path = resolve(configPath || CONFIG_FILE);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    console.error(
      chalk.red(`✗ Config not found: ${path}`) +
        chalk.dim("\n  Run: notion-sync init")
    );
    process.exit(1);
  }
}

function getToken() {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    console.error(
      chalk.red("✗ NOTION_TOKEN is not set.") +
        chalk.dim("\n  Add NOTION_TOKEN=your_token to your .env file.")
    );
    process.exit(1);
  }
  return token;
}

function getPageTitle(page) {
  if (Array.isArray(page.title)) {
    return page.title.map((t) => t.plain_text).join("").trim() || "(Untitled)";
  }
  if (page.properties) {
    const titleProp = Object.values(page.properties).find((p) => p.type === "title");
    return titleProp?.title?.map((t) => t.plain_text).join("").trim() || "(Untitled)";
  }
  return "(Untitled)";
}

function buildFrontmatterMap(samplePage) {
  const mappable = [
    "title", "rich_text", "select", "multi_select",
    "date", "checkbox", "number", "url", "created_time", "last_edited_time",
  ];
  const fm = {};
  for (const [name, prop] of Object.entries(samplePage.properties || {})) {
    if (mappable.includes(prop.type)) {
      fm[name.toLowerCase().replace(/\s+/g, "_")] = name;
    }
  }
  return fm;
}

async function deriveSpaceId(token, blockId) {
  const res = await fetch("https://www.notion.so/api/v3/syncRecordValues", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requests: [{ pointer: { table: "block", id: blockId }, version: -1 }] }),
  });
  if (!res.ok) throw new Error(`syncRecordValues returned ${res.status}`);
  const data = await res.json();
  const outer = data?.recordMap?.block?.[blockId];
  const block = outer?.value?.value || outer?.value;
  const spaceId = block?.space_id || outer?.spaceId || null;
  if (!spaceId) throw new Error("Could not resolve space_id from response");
  return spaceId;
}

// Logging helper - respects --quiet flag
function makeLog(quiet) {
  return {
    info: (...args) => { if (!quiet) console.log(...args); },
    error: (...args) => console.error(...args), // errors always shown
    spinner: (text) => {
      if (quiet) return { start: () => {}, succeed: () => {}, fail: (msg) => { console.error(msg); }, text: "" };
      return ora(text).start();
    },
  };
}

// ── init ──────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Interactive setup - pick workspace, then database or pages to sync")
  .option("--overwrite", "Overwrite existing config if present")
  .option("--non-interactive", "Skip prompts, use CLI flags instead")
  .option("--database-id <id>", "Database ID (for --non-interactive)")
  .option("--space-id <id>", "Space ID (for --non-interactive, optional - auto-detected if omitted)")
  .option("--output <dir>", "Output directory (for --non-interactive)", "./output")
  .action(async (opts) => {

    // ── Non-interactive mode ───────────────────────────────────────────────

    if (opts.nonInteractive) {
      if (!opts.databaseId) {
        console.error(chalk.red("✗ --database-id is required with --non-interactive"));
        process.exit(1);
      }

      const token = getToken();
      let spaceId = opts.spaceId || null;

      if (!spaceId) {
        const spinner = ora("Resolving workspace...").start();
        try {
          spaceId = await deriveSpaceId(token, opts.databaseId);
          spinner.succeed(chalk.dim(`Space ID: ${spaceId}`));
        } catch (err) {
          spinner.fail(chalk.red(`Failed to resolve space_id: ${err.message}`));
          process.exit(1);
        }
      }

      // Fetch one page to auto-detect frontmatter properties
      let frontmatter = { title: "Name" };
      try {
        const syncer = new NotionSync({ token, space_id: spaceId });
        syncer.spaceId = spaceId;
        const firstPage = await syncer.queryDatabase(opts.databaseId).next();
        if (firstPage.value) frontmatter = buildFrontmatterMap(firstPage.value);
      } catch { /* fall back to default */ }

      const config = {
        space_id: spaceId,
        source: "database",
        database_id: opts.databaseId,
        output_dir: opts.output,
        slug_property: null,
        frontmatter,
      };

      await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
      console.log(chalk.green(`✓ Saved ${CONFIG_FILE}`));
      return;
    }

    // ── Interactive mode ───────────────────────────────────────────────────

    if (existsSync(CONFIG_FILE) && !opts.overwrite) {
      const { proceed } = await inquirer.prompt([{
        type: "confirm",
        name: "proceed",
        message: `${CONFIG_FILE} already exists. Overwrite?`,
        default: false,
      }]);
      if (!proceed) return;
    }

    const token = getToken();
    const notion = new Client({ auth: token });

    console.log(chalk.bold("\n  Notion-sync\n"));

    // Note: workspace listing requires a browser session cookie (token_v2),
    // not a PAT. We derive space_id from syncRecordValues after the user picks.

    const { syncType } = await inquirer.prompt([{
      type: "select",
      name: "syncType",
      message: "What do you want to sync?",
      choices: [
        { name: "Database", value: "database" },
        { name: "Page", value: "page" },
      ],
    }]);

    // ── Branch A: database ─────────────────────────────────────────────────

    if (syncType === "database") {
      const dbSpinner = ora("Fetching databases...").start();
      let databases = [];
      try {
        const res = await notion.search({
          filter: { value: "database", property: "object" },
          page_size: 100,
        });
        databases = res.results;
        dbSpinner.succeed(`Found ${databases.length} database${databases.length !== 1 ? "s" : ""}`);
      } catch (err) {
        dbSpinner.fail(chalk.red(`Failed: ${err.message}`));
        process.exit(1);
      }

      if (databases.length === 0) {
        console.error(chalk.red("✗ No databases found.") +
          chalk.dim("\n  Share a database with your integration first."));
        process.exit(1);
      }

      const { databaseId } = await inquirer.prompt([{
        type: "select",
        name: "databaseId",
        message: "Database:",
        choices: databases.map((db) => ({ name: getPageTitle(db), value: db.id })),
        pageSize: 20,
      }]);

      const pageSpinner = ora("Fetching pages...").start();
      const syncer = new NotionSync({ token });
      const allPages = [];
      try {
        for await (const page of syncer.queryDatabase(databaseId)) {
          allPages.push(page);
        }
        pageSpinner.succeed(`Found ${allPages.length} page${allPages.length !== 1 ? "s" : ""}`);
      } catch (err) {
        pageSpinner.fail(chalk.red(`Failed: ${err.message}`));
        process.exit(1);
      }

      const spaceSpinner = ora("Resolving workspace...").start();
      let spaceId = null;
      try {
        const firstId = allPages[0]?.id || databaseId;
        spaceId = await deriveSpaceId(token, firstId);
        spaceSpinner.succeed(chalk.dim(`Space ID: ${spaceId}`));
      } catch (err) {
        spaceSpinner.fail(chalk.red(`Failed to resolve workspace: ${err.message}`));
        process.exit(1);
      }

      let pageFilter = null;
      if (allPages.length > 0) {
        const { pageSelection } = await inquirer.prompt([{
          type: "select",
          name: "pageSelection",
          message: "Pages to sync:",
          choices: [
            { name: `All  (${allPages.length})`, value: "all" },
            { name: "Let me pick", value: "pick" },
          ],
        }]);

        if (pageSelection === "pick") {
          const { picked } = await inquirer.prompt([{
            type: "checkbox",
            name: "picked",
            message: "Select pages:",
            choices: allPages.map((p) => ({ name: getPageTitle(p), value: p.id })),
            pageSize: 20,
            validate: (v) => v.length > 0 || "Select at least one page",
          }]);
          pageFilter = picked;
        }
      }

      const frontmatter = allPages.length > 0 ? buildFrontmatterMap(allPages[0]) : { title: "Name" };

      const config = {
        space_id: spaceId,
        source: "database",
        database_id: databaseId,
        ...(pageFilter ? { page_filter: pageFilter } : {}),
        output_dir: "./output",
        slug_property: null,
        frontmatter,
      };

      await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
      console.log("\n" + chalk.green(`✓ Saved ${CONFIG_FILE}`) + chalk.dim("  Run: notion-sync pull\n"));
    }

    // ── Branch B: page ─────────────────────────────────────────────────────

    else {
      const pageSpinner = ora("Fetching pages...").start();
      let allPages = [];
      try {
        const res = await notion.search({
          filter: { value: "page", property: "object" },
          page_size: 100,
        });
        allPages = res.results;
        pageSpinner.succeed(`Found ${allPages.length} page${allPages.length !== 1 ? "s" : ""}`);
      } catch (err) {
        pageSpinner.fail(chalk.red(`Failed: ${err.message}`));
        process.exit(1);
      }

      if (allPages.length === 0) {
        console.error(chalk.red("✗ No pages found. Share pages with your integration first."));
        process.exit(1);
      }

      const { pickedPages } = await inquirer.prompt([{
        type: "checkbox",
        name: "pickedPages",
        message: "Select pages:",
        choices: allPages.map((p) => ({ name: getPageTitle(p), value: p.id })),
        pageSize: 20,
        validate: (v) => v.length > 0 || "Select at least one page",
      }]);

      const spaceSpinner = ora("Resolving workspace...").start();
      let spaceId = null;
      try {
        spaceId = await deriveSpaceId(token, pickedPages[0]);
        spaceSpinner.succeed(chalk.dim(`Space ID: ${spaceId}`));
      } catch (err) {
        spaceSpinner.fail(chalk.red(`Failed to resolve workspace: ${err.message}`));
        process.exit(1);
      }

      const config = {
        space_id: spaceId,
        source: "pages",
        page_ids: pickedPages,
        output_dir: "./output",
        slug_property: null,
        frontmatter: {},
      };

      await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
      console.log("\n" + chalk.green(`✓ Saved ${CONFIG_FILE}`) + chalk.dim("  Run: notion-sync pull\n"));
    }
  });

// ── pull ──────────────────────────────────────────────────────────────────────

program
  .command("pull")
  .description("Pull pages from Notion as local markdown files")
  .option("-c, --config <path>", "Path to config file", CONFIG_FILE)
  .option("-p, --page <id>", "Pull a single page by ID (overrides config)")
  .option("-n, --name <query>", "Pull pages whose title contains the query (case-insensitive)")
  .option("-o, --output <dir>", "Output directory (overrides config output_dir)")
  .option("--pick", "Interactively pick which pages to pull this run")
  .option("--force", "Re-sync all pages, ignoring last-synced state")
  .option("--dry-run", "Preview what would be synced without writing files")
  .option("--quiet", "Suppress all output except errors")
  .action(async (opts) => {
    const token = getToken();
    const rawConfig = await loadConfig(opts.config);
    const config = { ...rawConfig, token };
    const log = makeLog(opts.quiet);

    // --name and --page are non-interactive by design, skip --pick
    const nonInteractive = !!(opts.name || opts.page);

    if (!config.space_id) {
      console.error(
        chalk.red("✗ space_id missing from config.") +
          chalk.dim("\n  Re-run: notion-sync init")
      );
      process.exit(1);
    }

    // --output flag overrides config output_dir
    const outputDir = resolve(opts.output || config.output_dir || "./output");
    const stateFile = resolve(STATE_FILE);

    if (!opts.dryRun) mkdirSync(outputDir, { recursive: true });

    const syncer = new NotionSync(config);
    syncer.spaceId = config.space_id;

    const state = opts.force ? {} : await syncer.loadState(stateFile);
    let pages = [];

    // ── Collect pages ──────────────────────────────────────────────────────

    if (opts.page) {
      const s = log.spinner("Fetching page...");
      try {
        const page = await syncer.notion.pages.retrieve({ page_id: opts.page });
        pages = [page];
        s.succeed(`Page: ${getPageTitle(page)}`);
      } catch (err) {
        s.fail(chalk.red(`Failed: ${err.message}`));
        process.exit(1);
      }

    } else if (opts.name) {
      if (!config.database_id) {
        console.error(chalk.red("✗ --name requires a database source. Run: notion-sync init"));
        process.exit(1);
      }
      const s = log.spinner(`Searching for "${opts.name}"...`);
      try {
        const all = [];
        for await (const page of syncer.queryDatabase(config.database_id)) {
          all.push(page);
        }
        const query = opts.name.toLowerCase();
        pages = all.filter((p) => getPageTitle(p).toLowerCase().includes(query));
        if (pages.length === 0) {
          s.fail(chalk.red(`No pages found matching "${opts.name}"`));
          process.exit(1);
        }
        s.succeed(`Found ${pages.length} match${pages.length !== 1 ? "es" : ""} for "${opts.name}"`);
      } catch (err) {
        s.fail(chalk.red(`Failed: ${err.message}`));
        process.exit(1);
      }

    } else if (config.source === "pages" || config.page_ids) {
      const s = log.spinner("Fetching pages...");
      try {
        for (const id of config.page_ids || []) {
          const page = await syncer.notion.pages.retrieve({ page_id: id });
          pages.push(page);
        }
        s.succeed(`Fetched ${pages.length} page${pages.length !== 1 ? "s" : ""}`);
      } catch (err) {
        s.fail(chalk.red(`Failed: ${err.message}`));
        process.exit(1);
      }

    } else {
      if (!config.database_id) {
        console.error(chalk.red("✗ No database_id in config. Run: notion-sync init"));
        process.exit(1);
      }
      const s = log.spinner("Fetching pages...");
      try {
        const all = [];
        for await (const page of syncer.queryDatabase(config.database_id)) {
          all.push(page);
        }
        pages = config.page_filter?.length
          ? all.filter((p) => config.page_filter.includes(p.id))
          : all;
        s.succeed(`Found ${pages.length} page${pages.length !== 1 ? "s" : ""}`);
      } catch (err) {
        s.fail(chalk.red(`Failed: ${err.message}`));
        process.exit(1);
      }
    }

    // ── Interactive picker (skipped when --name or --page are used) ────────

    if (!nonInteractive && opts.pick && pages.length > 0) {
      const { picked } = await inquirer.prompt([{
        type: "checkbox",
        name: "picked",
        message: "Select pages to pull this run:",
        choices: pages.map((p) => ({ name: getPageTitle(p), value: p.id, checked: true })),
        pageSize: 20,
        validate: (v) => v.length > 0 || "Select at least one page",
      }]);
      pages = pages.filter((p) => picked.includes(p.id));
    }

    // ── Skip unchanged ─────────────────────────────────────────────────────

    if (!opts.force && !opts.page) {
      const before = pages.length;
      pages = pages.filter((p) => {
        const lastSynced = state[p.id];
        return !lastSynced || new Date(p.last_edited_time) > new Date(lastSynced);
      });
      const skipped = before - pages.length;
      if (skipped > 0)
        log.info(chalk.dim(`  ${skipped} page${skipped !== 1 ? "s" : ""} up to date, skipping`));
    }

    if (pages.length === 0) {
      log.info(chalk.green("✓ Everything is up to date"));
      process.exit(0);
    }

    // ── Dry run ────────────────────────────────────────────────────────────

    if (opts.dryRun) {
      log.info(chalk.yellow(`\nDry run - would sync ${pages.length} page${pages.length !== 1 ? "s" : ""}:\n`));
      for (const page of pages) {
        const slug = syncer.getSlug(page, config.slug_property);
        log.info(`  ${chalk.dim(outputDir + "/")}${slug}/  ${chalk.dim(getPageTitle(page))}`);
      }
      process.exit(0);
    }

    // ── Sync ───────────────────────────────────────────────────────────────

    log.info("");
    let synced = 0;
    let failed = 0;

    for (const page of pages) {
      const title = getPageTitle(page);
      const s = log.spinner(`  ${title}`);
      try {
        const result = await syncer.processPage(page, {
          outputDir,
          fieldMap: config.frontmatter || {},
          slugProperty: config.slug_property,
          onProgress: (msg) => { s.text = `  ${title} ${chalk.dim(msg)}`; },
        });
        state[page.id] = new Date().toISOString();
        synced++;
        s.succeed(
          `  ${chalk.green(title)} ` +
            chalk.dim(`-> ${result.slug}/  (${result.imageCount} image${result.imageCount !== 1 ? "s" : ""})`)
        );
      } catch (err) {
        failed++;
        s.fail(`  ${chalk.red(title)}: ${chalk.dim(err.message)}`);
      }
    }

    await syncer.saveState(stateFile, state);

    log.info("");
    log.info(
      chalk.green(`✓ Synced ${synced} page${synced !== 1 ? "s" : ""}`) +
        (failed ? chalk.red(` · ${failed} failed`) : "") +
        chalk.dim(`  ->  ${outputDir}`)
    );

    if (failed > 0) process.exit(1);
    process.exit(0);
  });

// ── watch ─────────────────────────────────────────────────────────────────────

program
  .command("watch")
  .description("Poll Notion for changes and sync automatically")
  .option("-c, --config <path>", "Path to config file", CONFIG_FILE)
  .option("-i, --interval <seconds>", "Poll interval in seconds", "60")
  .action(async (opts) => {
    const intervalMs = parseInt(opts.interval) * 1000;
    console.log(
      chalk.cyan("Notion-sync watch") +
        chalk.dim(` - polling every ${opts.interval}s  (Ctrl+C to stop)\n`)
    );
    const runPull = async () => {
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      try {
        const { stdout } = await promisify(execFile)(process.argv[1], ["pull", "--config", opts.config]);
        process.stdout.write(stdout);
      } catch (err) {
        console.error(chalk.red("Pull failed:"), err.stderr || err.message);
      }
    };
    await runPull();
    setInterval(runPull, intervalMs);
  });

// ── status ────────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show which pages were synced and when")
  .action(async () => {
    const stateFile = resolve(STATE_FILE);
    let state;
    try {
      state = JSON.parse(await readFile(stateFile, "utf-8"));
    } catch {
      console.log(chalk.dim("No sync state found. Run: notion-sync pull"));
      return;
    }
    const entries = Object.entries(state);
    if (entries.length === 0) { console.log(chalk.dim("No pages synced yet.")); return; }
    console.log(chalk.bold(`\n${entries.length} synced pages:\n`));
    for (const [id, ts] of entries.sort((a, b) => b[1].localeCompare(a[1])))
      console.log(`  ${chalk.dim(id)}  ${new Date(ts).toLocaleString()}`);
  });

// ── main ──────────────────────────────────────────────────────────────────────

program
  .name("notion-sync")
  .description("Notion-sync - sync Notion pages and databases to local markdown files")
  .version("1.0.0");

program.parse();
