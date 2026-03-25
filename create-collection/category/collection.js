import fs from "fs";
import { parse } from "csv-parse/sync";
<<<<<<< HEAD
import path from 'path';
import dotenv from 'dotenv';

// Try loading .env from current or parent folders (repo root .env may be up two levels)
const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../.env'),
  path.resolve(process.cwd(), '../../.env'),
];
let envLoaded = false;
for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    envLoaded = true;
    break;
  }
}
if (!envLoaded) dotenv.config();
=======
>>>>>>> 2d8bfb3 (security: read SHOPIFY_ACCESS_TOKEN from env, add .env.sample)

// ---- Config ----
const SHOP = "sevenfive-4062.myshopify.com";
// Read access token from environment variable for security.
<<<<<<< HEAD
// Create a `.env` file with `SHOPIFY_ACCESS_TOKEN=REDACTED_SHOPIFY_TOKEN` or export the var in your shell.
// Support both a generic and a category-specific env var name.
// const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN_CATEGORY;
// const ACCESS_TOKEN = ""
const FILE = "./sub-cat.csv";
const DRY_RUN = false; // ✅ set false เมื่อพร้อม run จริง

if (!ACCESS_TOKEN && !DRY_RUN) {
  throw new Error(
    "Missing SHOPIFY_ACCESS_TOKEN (or SHOPIFY_ACCESS_TOKEN_CATEGORY) environment variable.\nCreate a .env file with SHOPIFY_ACCESS_TOKEN=REDACTED_SHOPIFY_TOKEN (or SHOPIFY_ACCESS_TOKEN_CATEGORY) or export the variable before running."
=======
// Create a `.env` file with `SHOPIFY_ACCESS_TOKEN=shpat_xxx` or export the var in your shell.
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const FILE = "./collections.csv";
const DRY_RUN = false; // ✅ set false เมื่อพร้อม run จริง

if (!ACCESS_TOKEN) {
  throw new Error(
    "Missing SHOPIFY_ACCESS_TOKEN environment variable.\nCreate a .env file with SHOPIFY_ACCESS_TOKEN=shpat_xxx or export the variable before running."
>>>>>>> 2d8bfb3 (security: read SHOPIFY_ACCESS_TOKEN from env, add .env.sample)
  );
}
// ----------------

const MUTATION = `
  mutation CreateCollection($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection {
        id
        title
        handle
        seo { title description }
      }
      userErrors { field message }
    }
  }
`;

<<<<<<< HEAD
const CHANNELS_QUERY = `
  query GetChannels($first: Int!) {
    channels(first: $first) {
      edges { node { id handle } }
    }
  }
`;

const PUBLISH_MUTATION = `
  mutation Publish($id: ID!, $channelIds: [ID!]!) {
    publishablePublish(id: $id, channelIds: $channelIds) {
      userErrors { field message }
    }
  }
`;

=======
>>>>>>> 2d8bfb3 (security: read SHOPIFY_ACCESS_TOKEN from env, add .env.sample)
async function graphql(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function main() {
  const raw = fs.readFileSync(FILE, "utf8");
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true, // ✅ ตัด BOM อัตโนมัติ
  });

  // Debug headers
  console.log("📌 Headers detected:", Object.keys(rows[0]));
  console.log(`📋 Found ${rows.length} collections\n`);

  const results = [];

  for (const row of rows) {
    // Guard: skip ถ้าไม่มี title
    if (!row.title) {
      console.warn(`⚠️  Skipped row — missing title:`, row);
      continue;
    }

    const rules = [];
    if (row.type) rules.push({ column: "TYPE", relation: "EQUALS", condition: row.type });
    if (row.tag)  rules.push({ column: "TAG",          relation: "EQUALS", condition: row.tag  });

    if (rules.length === 0) {
      console.warn(`⚠️  Skipped "${row.title}" — no type or tag`);
      continue;
    }

    const input = {
      title: row.title,
      ruleSet: {
        appliedDisjunctively: row.and_or?.toUpperCase() === "OR",
        rules,
      },
      seo: {
        title:       row.seo_title?.trim()       || row.title,
        description: row.seo_description?.trim() || "",
      },
    };

    if (DRY_RUN) {
      console.log(`🔍 DRY RUN — ${row.title}:`, JSON.stringify(input, null, 2));
      results.push({ title: row.title, status: "dry_run" });
      continue;
    }

    try {
      const res = await graphql(MUTATION, { input });

      if (!res) {
        throw new Error("No response from GraphQL");
      }
      if (res.errors && res.errors.length) {
        console.error(`❌ GraphQL errors for ${row.title}:`, res.errors);
        results.push({ title: row.title, status: "error", errors: res.errors });
        continue;
      }
      if (!res.data || !res.data.collectionCreate) {
        console.error(`❌ Unexpected GraphQL response for ${row.title}:`, res);
        results.push({ title: row.title, status: "error", errors: ["Unexpected GraphQL response"] });
        continue;
      }

      const { collection, userErrors } = res.data.collectionCreate;

      if (userErrors && userErrors.length > 0) {
        console.error(`❌ ${row.title}:`, userErrors);
        results.push({ title: row.title, status: "error", errors: userErrors });
      } else {
        console.log(`✅ ${collection.title} → /collections/${collection.handle}`);
        results.push({
          title:  row.title,
          status: "ok",
          id:     collection.id,
          handle: collection.handle,
        });
<<<<<<< HEAD

        // Handle publish flag: if CSV 'publish' truthy, publish to Online Store channel
        try {
          const publishFlag = String(row.publish || "").trim().toLowerCase();
          if (publishFlag === "true" || publishFlag === "1" || publishFlag === "yes") {
            // Fetch channels once (cached)
            if (typeof global.__ONLINE_STORE_CHANNEL_ID === 'undefined') {
              const chRes = await graphql(CHANNELS_QUERY, { first: 20 });
              const edges = chRes?.data?.channels?.edges || [];
              const online = edges.find((e) => e.node.handle === 'online_store');
              global.__ONLINE_STORE_CHANNEL_ID = online ? online.node.id : null;
            }

            const onlineId = global.__ONLINE_STORE_CHANNEL_ID;
            if (!onlineId) {
              console.warn(`⚠️  Cannot publish ${collection.title}: Online Store channel not found`);
            } else {
              const pubRes = await graphql(PUBLISH_MUTATION, { id: collection.id, channelIds: [onlineId] });
              const pubErrors = pubRes?.data?.publishablePublish?.userErrors || pubRes?.errors || [];
              if (pubErrors.length > 0) {
                console.error(`❌ Publish errors for ${row.title}:`, pubErrors);
                // update results entry to indicate publish error
                results[results.length - 1].publish = { status: 'error', errors: pubErrors };
              } else {
                console.log(`📣 Published ${collection.title} to Online Store`);
                results[results.length - 1].publish = { status: 'ok' };
              }
            }
          }
        } catch (pubErr) {
          console.error(`💥 ${row.title} — publish unexpected error:`, pubErr.message || pubErr);
          results[results.length - 1].publish = { status: 'exception', error: pubErr.message || String(pubErr) };
        }
=======
>>>>>>> 2d8bfb3 (security: read SHOPIFY_ACCESS_TOKEN from env, add .env.sample)
      }
    } catch (err) {
      console.error(`💥 ${row.title} — unexpected error:`, err.message || err);
      results.push({ title: row.title, status: "exception", error: err.message || String(err) });
    }

    await new Promise((r) => setTimeout(r, 500)); // rate limit buffer
  }

  // Summary
  console.log("\n--- Summary ---");
  const ok  = results.filter((r) => r.status === "ok").length;
  const err = results.filter((r) => r.status === "error").length;
  const exc = results.filter((r) => r.status === "exception").length;
  console.log(`✅ Success: ${ok} | ❌ Error: ${err} | 💥 Exception: ${exc} | Total: ${results.length}`);

  fs.writeFileSync("./result.json", JSON.stringify(results, null, 2));
  console.log("📄 Saved to result.json");
}

main();
