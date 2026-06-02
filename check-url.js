import { Client } from "@notionhq/client";
import { readFile } from "fs/promises";

async function test() {
  try {
    const env = await readFile(".env", "utf-8");
    const token = env.match(/NOTION_TOKEN=(.*)/)?.[1]?.trim();
    const notion = new Client({ auth: token });

    const blockId = "3720f091-be70-803a-a063-e805e817e7c0";
    const block = await notion.blocks.retrieve({ block_id: blockId });
    console.log("Official API Block Image Data:");
    console.log(JSON.stringify(block.image, null, 2));
  } catch (err) {
    console.error("Error:", err.message);
  }
}
test();
