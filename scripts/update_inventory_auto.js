// ============================================================
// CONFIG
// ============================================================
const SHOP = "sevenfive-4062.myshopify.com";
const CLIENT_ID = "";
const CLIENT_SECRET = "";
const LOCATION_ID = "gid://shopify/Location/85456027847";
const SHEET_NAME = "Inventory";
const LOG_SHEET_NAME = "Log run script";

const CHUNK_SIZE = 100;
const MAX_RUNTIME_MS = 4.5 * 60 * 1000;
const RESUME_AFTER_MS = 60 * 1000;

const PROP_NEXT_INDEX    = "INV_NEXT_INDEX";
const PROP_TOTAL_SUCCESS = "INV_TOTAL_SUCCESS";
const PROP_TOTAL_SKIP    = "INV_TOTAL_SKIP";
const PROP_ACCESS_TOKEN  = "ACCESS_TOKEN";
const PROP_TOKEN_EXPIRY  = "TOKEN_EXPIRY";
const PROP_IS_RUNNING    = "INV_IS_RUNNING";
const PROP_RUN_DATE      = "INV_RUN_DATE";
const PROP_RUN_START     = "INV_RUN_START";
const PROP_RUN_STATUS    = "INV_RUN_STATUS"; // "running" | "completed" | "failed"

const CACHE_SHEET_NAME = "GoodID Cache";
const RESUME_HANDLER   = "updateInventory";
const INV_ITEM_ID_COL  = 4; // col D ใน sheet Inventory — cached InventoryItemId

// ============================================================
// MANUAL RUN — กดปุ่มจาก editor ได้เสมอ ไม่มี skip
// ============================================================
function runInventoryNow() {
  const props = PropertiesService.getScriptProperties();
  const tz    = Session.getScriptTimeZone() || "Asia/Bangkok";

  Logger.log("[MANUAL] Force-resetting all state and starting job...");
  resetState_();

  props.setProperty(PROP_RUN_DATE,   Utilities.formatDate(new Date(), tz, "yyyy-MM-dd"));
  props.setProperty(PROP_RUN_START,  new Date().toISOString());
  props.setProperty(PROP_RUN_STATUS, "running");

  updateInventory();
}

// ============================================================
// TRIGGER ENTRY — ใช้กับ Time-based trigger เท่านั้น
//   จะ skip ถ้า: กำลัง running / completed วันนี้แล้ว / pause รอ resume
// ============================================================
function dailyInventoryTrigger() {
  const props     = PropertiesService.getScriptProperties();
  const tz        = Session.getScriptTimeZone() || "Asia/Bangkok";
  const todayKey  = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  const isRunning = props.getProperty(PROP_IS_RUNNING) === "true";
  const runDate   = props.getProperty(PROP_RUN_DATE);
  const runStatus = props.getProperty(PROP_RUN_STATUS);

  if (isRunning) { Logger.log("[SKIP] Job is already running."); return; }
  if (runDate === todayKey && runStatus === "completed") { Logger.log("[SKIP] Already completed for " + todayKey); return; }
  if (runDate === todayKey && runStatus === "running")   { Logger.log("[SKIP] Job is paused — waiting for resume trigger."); return; }

  if (runDate !== todayKey) {
    Logger.log("[START] New day — clearing state from " + (runDate || "none"));
  } else {
    Logger.log("[RESTART] Previous status=" + (runStatus || "unknown") + " — restarting for " + todayKey);
  }

  resetState_();
  props.setProperty(PROP_RUN_DATE,   todayKey);
  props.setProperty(PROP_RUN_START,  new Date().toISOString());
  props.setProperty(PROP_RUN_STATUS, "running");

  updateInventory();
}

// ============================================================
// MAIN WORKER
//
//  Flow:
//    ยังไม่จบ → saveProgress() + scheduleResume() → return
//    จบแล้ว  → logSuccess() + clearState()       → return
// ============================================================
function updateInventory() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    Logger.log("[SKIP] Another process is running");
    return;
  }

  const startTime  = Date.now();
  const props      = PropertiesService.getScriptProperties();
  let totalSuccess = Number(props.getProperty(PROP_TOTAL_SUCCESS) || 0);
  let totalSkip    = Number(props.getProperty(PROP_TOTAL_SKIP)    || 0);

  try {
    props.setProperty(PROP_IS_RUNNING, "true");

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error('Sheet "' + SHEET_NAME + '" not found');

    const rows = getValidRows_(sheet);
    if (rows.length === 0) {
      logSuccess_(0, 0, "No data");
      return;
    }

    let nextIndex = Number(props.getProperty(PROP_NEXT_INDEX) || 0);
    Logger.log("[RUN] Total rows: " + rows.length + " | Start index: " + nextIndex);

    while (nextIndex < rows.length) {

      // ใกล้หมดเวลา → save progress + schedule resume
      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        saveProgress_(props, nextIndex, totalSuccess, totalSkip);
        props.deleteProperty(PROP_IS_RUNNING);
        scheduleResume_();
        Logger.log("[PAUSE] Saved at index " + nextIndex + " — resume trigger scheduled");
        return;
      }

      const chunk     = rows.slice(nextIndex, nextIndex + CHUNK_SIZE);
      const quantities         = [];
      const quantityRowIndices = [];

      chunk.forEach(function(r) {
        if (r.inventoryItemId) {
          quantities.push({ inventoryItemId: r.inventoryItemId, quantity: r.quantity });
          quantityRowIndices.push(r.rowIndex);
        } else {
          totalSkip++;
          Logger.log("[SKIP] No InventoryItemId in col D — SKU: '" + r.sku + "' | GoodID: '" + r.goodId + "' | Row: " + r.rowIndex + " (run refreshGoodIdCache first)");
        }
      });

      // ── อัปเดต inventory ──
      if (quantities.length > 0) {
        try {
          const result     = setInventoryQuantitiesBatch_(quantities);
          const topErrors  = (result && result.errors) ? result.errors : [];
          const userErrors = (result && result.data && result.data.inventorySetQuantities)
                             ? result.data.inventorySetQuantities.userErrors : [];

          if (topErrors.length > 0) {
            Logger.log("[ERROR] GraphQL errors: " + JSON.stringify(topErrors));
            totalSkip += quantities.length;
          } else if (userErrors.length > 0) {
            Logger.log("[ERROR] User errors: " + JSON.stringify(userErrors));
            // clear col D สำหรับ entry ที่ Shopify บอกว่า "inventory item could not be found"
            const clearRowIndices = [];
            userErrors.forEach(function(e) {
              if (e.field && e.field[2] !== undefined &&
                  String(e.message).indexOf("could not be found") !== -1) {
                const idx = Number(e.field[2]);
                if (!isNaN(idx) && quantityRowIndices[idx]) {
                  clearRowIndices.push(quantityRowIndices[idx]);
                }
              }
            });
            if (clearRowIndices.length > 0) {
              clearCachedInventoryItemIds_(sheet, clearRowIndices);
              Logger.log("[CACHE] Cleared " + clearRowIndices.length + " invalid IDs from col D — run refreshGoodIdCache to fix");
            }
            totalSkip += quantities.length;
          } else {
            totalSuccess += quantities.length;
            Logger.log("[OK] Updated " + quantities.length + " items (index " + nextIndex + "–" + (nextIndex + chunk.length - 1) + ")");
          }
        } catch (err) {
          Logger.log("[ERROR] setInventoryQuantitiesBatch_ at index " + nextIndex + ": " + err.message);
          totalSkip += quantities.length;
          nextIndex += CHUNK_SIZE;
          saveProgress_(props, nextIndex, totalSuccess, totalSkip);
          Utilities.sleep(2000);
          continue;
        }
      }

      nextIndex += CHUNK_SIZE;
      saveProgress_(props, nextIndex, totalSuccess, totalSkip);
      Utilities.sleep(800);
    }

    // ── จบครบทุก row ──
    Logger.log("[DONE] Success: " + totalSuccess + " | Skipped: " + totalSkip);
    logSuccess_(totalSuccess, totalSkip, "Completed");

  } catch (err) {
    Logger.log("[EXCEPTION] " + err.message + "\n" + (err.stack || ""));
    logFailed_(err, totalSuccess, totalSkip);
    props.deleteProperty(PROP_IS_RUNNING);
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// SAVE PROGRESS
// ============================================================
function saveProgress_(props, nextIndex, totalSuccess, totalSkip) {
  props.setProperty(PROP_NEXT_INDEX,    String(nextIndex));
  props.setProperty(PROP_TOTAL_SUCCESS, String(totalSuccess));
  props.setProperty(PROP_TOTAL_SKIP,    String(totalSkip));
}

// ============================================================
// FINALIZE — SUCCESS
// ============================================================
function logSuccess_(totalSuccess, totalSkip, message) {
  writeLog_("SUCCESS", totalSuccess, totalSkip, message);
  PropertiesService.getScriptProperties().setProperty(PROP_RUN_STATUS, "completed");
  clearState_();
  Logger.log("[OK] Job completed and state cleared.");
}

// ============================================================
// FINALIZE — FAILED
// ============================================================
function logFailed_(error, totalSuccess, totalSkip) {
  const msg = (error && error.message) ? error.message : String(error);
  writeLog_("FAILED", totalSuccess, totalSkip, msg);
  PropertiesService.getScriptProperties().setProperty(PROP_RUN_STATUS, "failed");
}

// ============================================================
// GET INVENTORY ITEM IDs BY SKUs (Batch)
// ============================================================
function getInventoryItemsBySKUs_(skus) {
  const cleanedSkus = skus
    .map(function(s) { return String(s || "").trim(); })
    .filter(Boolean)
    .map(escapeGraphQLSearchValue_);

  if (cleanedSkus.length === 0) return {};

  const query = '\n    query {\n      productVariants(first: 100, query: "' +
    cleanedSkus.map(function(s) { return "sku:'" + s + "'"; }).join(" OR ") +
    '") {\n        edges {\n          node {\n            sku\n            inventoryItem { id }\n          }\n        }\n      }\n    }\n  ';

  const res = callGraphQL_(query);
  const map = {};

  if (res && res.data && res.data.productVariants && res.data.productVariants.edges) {
    res.data.productVariants.edges.forEach(function(e) {
      const sku             = e && e.node && e.node.sku;
      const inventoryItemId = e && e.node && e.node.inventoryItem && e.node.inventoryItem.id;
      if (sku && inventoryItemId) map[sku] = inventoryItemId;
    });
  }

  return map;
}

// ============================================================
// GET INVENTORY ITEM IDs BY Good ID METAFIELD
//   1. อ่าน cache จาก sheet "GoodID Cache" ก่อน
//   2. scan Shopify เฉพาะ GoodID ที่ยังไม่อยู่ใน cache
//   3. บันทึก hit ใหม่กลับลง cache
// ============================================================
function getInventoryItemsByGoodIds_(targetGoodIds) {
  const targetSet = {};
  targetGoodIds.forEach(function(id) {
    if (id) targetSet[String(id).trim()] = true;
  });
  if (Object.keys(targetSet).length === 0) return {};

  // ── 1. อ่าน cache ──
  const cache = loadGoodIdCache_();

  const map     = {};
  const missing = [];
  Object.keys(targetSet).forEach(function(id) {
    if (cache[id]) {
      map[id] = cache[id];
    } else {
      missing.push(id);
    }
  });

  Logger.log("[GOODID] Cache hit: " + Object.keys(map).length + " | Miss (scan needed): " + missing.length);
  if (missing.length === 0) return map;

  // ── 2. scan Shopify เฉพาะที่ยังไม่มีใน cache ──
  const missingSet = {};
  missing.forEach(function(id) { missingSet[id] = true; });

  var cursor  = null;
  var found   = 0;
  var total   = missing.length;
  const newEntries = {};

  do {
    const afterClause = cursor ? ', after: "' + cursor + '"' : "";
    const query = [
      "{",
      "  products(first: 250" + afterClause + ") {",
      "    pageInfo { hasNextPage endCursor }",
      "    edges {",
      "      node {",
      '        metafield(namespace: "custom", key: "good_id") { value }',
      "        variants(first: 1) {",
      "          edges { node { inventoryItem { id } } }",
      "        }",
      "      }",
      "    }",
      "  }",
      "}"
    ].join("\n");

    const res = callGraphQL_(query);
    if (!res || !res.data || !res.data.products) break;

    const products = res.data.products;
    products.edges.forEach(function(e) {
      const node   = e.node;
      const mf     = node.metafield;
      const goodId = mf ? String(mf.value || "").trim() : null;
      if (!goodId || !missingSet[goodId]) return;
      const edges  = node.variants && node.variants.edges;
      if (edges && edges.length > 0) {
        const invItemId = edges[0].node.inventoryItem && edges[0].node.inventoryItem.id;
        if (invItemId && !map[goodId]) {
          map[goodId]         = invItemId;
          newEntries[goodId]  = invItemId;
          found++;
        }
      }
    });

    if (found >= total) break;
    cursor = products.pageInfo.hasNextPage ? products.pageInfo.endCursor : null;

  } while (cursor);

  Logger.log("[GOODID] Scanned — found " + found + "/" + total + " missing IDs");

  // ── 3. save hit ใหม่กลับลง cache ──
  if (Object.keys(newEntries).length > 0) {
    saveGoodIdCache_(newEntries);
  }

  return map;
}

// ============================================================
// CACHE HELPERS — Sheet "GoodID Cache"
//   Columns: A=GoodID | B=SKU | C=InventoryItemId | D=CachedAt
//   (รองรับ format เก่า 3 col: A=GoodID | B=InventoryItemId | C=CachedAt)
// ============================================================
function loadGoodIdCache_() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CACHE_SHEET_NAME);
  const cache = {}; // goodId → inventoryItemId
  if (!sheet || sheet.getLastRow() < 2) return cache;

  const lastCol = sheet.getLastColumn();
  const data    = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues();
  data.forEach(function(row) {
    const goodId = String(row[0] || "").trim();
    const col2   = String(row[1] || "").trim();
    const col3   = lastCol >= 3 ? String(row[2] || "").trim() : "";
    // col3 เป็น InventoryItemId (4-col format) หรือ col2 เป็น InventoryItemId (3-col format เก่า)
    const invItem = col3.indexOf("gid://") === 0 ? col3
                  : col2.indexOf("gid://") === 0 ? col2
                  : "";
    if (goodId && invItem) cache[goodId] = invItem;
  });
  return cache;
}

function saveGoodIdCache_(newEntries) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet   = ss.getSheetByName(CACHE_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(CACHE_SHEET_NAME);
    sheet.appendRow(["GoodID", "InventoryItemId", "CachedAt"]);
    sheet.setFrozenRows(1);
  }

  // อ่าน row เดิมเพื่อ update แทนที่ถ้ามี key ซ้ำ
  const lastRow  = sheet.getLastRow();
  const existing = {}; // goodId → row number
  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    ids.forEach(function(r, i) {
      const id = String(r[0] || "").trim();
      if (id) existing[id] = i + 2; // 1-indexed
    });
  }

  const now = new Date().toISOString();
  Object.keys(newEntries).forEach(function(goodId) {
    const invItemId = newEntries[goodId];
    if (existing[goodId]) {
      // update row เดิม
      sheet.getRange(existing[goodId], 2, 1, 2).setValues([[invItemId, now]]);
    } else {
      // append row ใหม่
      sheet.appendRow([goodId, invItemId, now]);
    }
  });

  Logger.log("[CACHE] Saved " + Object.keys(newEntries).length + " entries to '" + CACHE_SHEET_NAME + "'");
}

// ============================================================
// REFRESH GOOD ID CACHE — scan ทุก product แล้ว fill col D ใน Inventory sheet
//   รันครั้งแรก หรือเมื่อเพิ่มสินค้าใหม่
//   1. Scan ทุก product → สร้าง skuMap + goodIdMap + cacheRows (ทุก variant)
//   2. Match กับ Inventory sheet → เขียน InventoryItemId ลง col D
//   3. บันทึก GoodID Cache sheet (InventoryItemId เป็น primary)
// ============================================================
function refreshGoodIdCache() {
  Logger.log("[CACHE] Starting full product scan...");

  const skuMap    = {}; // sku → inventoryItemId
  const goodIdMap = {}; // goodId → inventoryItemId
  const cacheRows = []; // [invItemId, sku, goodId] — ทุก variant รวมถึงที่ไม่มี SKU/GoodID
  var cursor      = null;
  var productCount = 0;

  // ── 1. scan ทุก product ──
  do {
    const afterClause = cursor ? ', after: "' + cursor + '"' : "";
    const query = [
      "{",
      "  products(first: 250" + afterClause + ") {",
      "    pageInfo { hasNextPage endCursor }",
      "    edges {",
      "      node {",
      "        id",
      '        metafield(namespace: "custom", key: "good_id") { value }',
      "        variants(first: 100) {",
      "          edges {",
      "            node {",
      "              sku",
      "              inventoryItem { id }",
      "            }",
      "          }",
      "        }",
      "      }",
      "    }",
      "  }",
      "}"
    ].join("\n");

    const res = callGraphQL_(query);
    if (!res || !res.data || !res.data.products) break;

    const products = res.data.products;
    products.edges.forEach(function(e) {
      const node      = e.node;
      const productId = node.id || "";
      const mf        = node.metafield;
      const goodId    = mf ? String(mf.value || "").trim() : "";
      const varEdges  = node.variants && node.variants.edges;
      if (!varEdges || varEdges.length === 0) return;

      varEdges.forEach(function(ve) {
        const v         = ve.node;
        const sku       = String(v.sku || "").trim();
        const invItemId = v.inventoryItem ? v.inventoryItem.id : null;
        if (!invItemId) return;

        // build lookup maps
        if (sku)    skuMap[sku]       = invItemId;
        if (goodId) goodIdMap[goodId] = invItemId;

        // เก็บทุก variant — GoodID เป็น col A (blank ถ้าไม่มี)
        cacheRows.push([goodId, sku, invItemId, productId]);
      });
      productCount++;
    });

    cursor = products.pageInfo.hasNextPage ? products.pageInfo.endCursor : null;

  } while (cursor);

  Logger.log("[CACHE] Scanned " + productCount + " products | Total variants: " + cacheRows.length + " | SKUs: " + Object.keys(skuMap).length + " | GoodIDs: " + Object.keys(goodIdMap).length);

  // ── 2. fill col D ใน Inventory sheet ──
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const invSheet = ss.getSheetByName(SHEET_NAME);
  if (!invSheet || invSheet.getLastRow() < 2) {
    Logger.log("[CACHE] Inventory sheet is empty — skipping col D fill");
  } else {
    const data    = invSheet.getRange(2, 1, invSheet.getLastRow() - 1, 4).getValues();
    const updates = [];
    var filled = 0;
    var alreadyHad = 0;

    data.forEach(function(row, i) {
      const sku      = String(row[0] || "").trim();
      const goodId   = String(row[2] || "").trim();
      const existing = String(row[3] || "").trim();

      // ถ้ามีอยู่แล้วและ valid → ไม่ต้อง overwrite
      if (/^gid:\/\/shopify\/InventoryItem\/\d+$/.test(existing)) {
        alreadyHad++;
        return;
      }

      var invItemId = null;
      if (sku && skuMap[sku])              invItemId = skuMap[sku];
      else if (goodId && goodIdMap[goodId]) invItemId = goodIdMap[goodId];

      if (invItemId) {
        updates.push({ rowIndex: i + 2, invItemId: invItemId });
        filled++;
      }
    });

    updates.forEach(function(u) {
      invSheet.getRange(u.rowIndex, INV_ITEM_ID_COL).setValue(u.invItemId);
    });

    Logger.log("[CACHE] Inventory col D — filled: " + filled + " | already had: " + alreadyHad + " | total rows: " + data.length);
  }

  // ── 3. เขียนทับ GoodID Cache sheet (InventoryItemId เป็น primary) ──
  var cacheSheet = ss.getSheetByName(CACHE_SHEET_NAME);
  if (!cacheSheet) {
    cacheSheet = ss.insertSheet(CACHE_SHEET_NAME);
    cacheSheet.setFrozenRows(1);
  } else {
    cacheSheet.clearContents();
  }

  cacheSheet.appendRow(["GoodID", "SKU", "InventoryItemId", "ProductGID", "CachedAt"]);
  const tz  = Session.getScriptTimeZone() || "Asia/Bangkok";
  const now = Utilities.formatDate(new Date(), tz, "dd/MM/yyyy HH:mm");
  if (cacheRows.length > 0) {
    const rowsWithTime = cacheRows.map(function(r) { return [r[0], r[1], r[2], r[3], now]; });
    cacheSheet.getRange(2, 1, rowsWithTime.length, 5).setValues(rowsWithTime);
  }

  Logger.log("[CACHE] Refresh complete — " + cacheRows.length + " variants written to '" + CACHE_SHEET_NAME + "'");
}

// ============================================================
// BATCH SET INVENTORY QUANTITIES
// ============================================================
function setInventoryQuantitiesBatch_(quantities) {
  const gql = quantities.map(function(q) {
    return '{\n      inventoryItemId: "' + q.inventoryItemId + '"\n      locationId: "' + LOCATION_ID + '"\n      quantity: ' + Number(q.quantity) + '\n    }';
  }).join(",");

  const mutation = '\n    mutation {\n      inventorySetQuantities(\n        input: {\n          name: "available"\n          quantities: [' + gql + ']\n          reason: "correction"\n          ignoreCompareQuantity: true\n        }\n      ) {\n        inventoryAdjustmentGroup { id }\n        userErrors { field message }\n      }\n    }\n  ';

  return callGraphQL_(mutation);
}

// ============================================================
// GRAPHQL CALLER — with retry + exponential backoff
// ============================================================
function callGraphQL_(query, retryCount) {
  if (retryCount === undefined) retryCount = 0;

  const MAX_RETRIES     = 3;
  const RETRY_DELAY_MS  = [1000, 3000, 7000];
  const RETRYABLE_CODES = [429, 502, 503, 504, 520];

  var res;
  try {
    res = UrlFetchApp.fetch(
      "https://" + SHOP + "/admin/api/2025-01/graphql.json",
      {
        method: "post",
        contentType: "application/json",
        headers: { "X-Shopify-Access-Token": getAccessToken_() },
        payload: JSON.stringify({ query: query }),
        muteHttpExceptions: true
      }
    );
  } catch (fetchErr) {
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS[retryCount];
      Logger.log("[RETRY " + (retryCount+1) + "/" + MAX_RETRIES + "] Fetch error: " + fetchErr.message + ". Waiting " + delay + "ms...");
      Utilities.sleep(delay);
      return callGraphQL_(query, retryCount + 1);
    }
    throw new Error("Fetch failed after " + MAX_RETRIES + " retries: " + fetchErr.message);
  }

  const code = res.getResponseCode();
  const text = res.getContentText();

  if (RETRYABLE_CODES.indexOf(code) !== -1) {
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS[retryCount];
      Logger.log("[RETRY " + (retryCount+1) + "/" + MAX_RETRIES + "] HTTP " + code + ". Waiting " + delay + "ms...");
      Utilities.sleep(delay);
      return callGraphQL_(query, retryCount + 1);
    }
    throw new Error("GraphQL HTTP " + code + " after " + MAX_RETRIES + " retries: " + text.substring(0, 300));
  }

  if (code >= 400) {
    throw new Error("GraphQL HTTP " + code + ": " + text.substring(0, 500));
  }

  var json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS[retryCount];
      Logger.log("[RETRY " + (retryCount+1) + "/" + MAX_RETRIES + "] Invalid JSON (HTTP " + code + "). Waiting " + delay + "ms...");
      Utilities.sleep(delay);
      return callGraphQL_(query, retryCount + 1);
    }
    throw new Error("Invalid JSON. HTTP " + code + ": " + text.substring(0, 300));
  }

  return json;
}

// ============================================================
// AUTH — Auto refresh token
// ============================================================
function getAccessToken_() {
  const props  = PropertiesService.getScriptProperties();
  const token  = props.getProperty(PROP_ACCESS_TOKEN);
  const expiry = Number(props.getProperty(PROP_TOKEN_EXPIRY) || 0);

  if (token && Date.now() < expiry - 300000) return token;

  const res  = UrlFetchApp.fetch("https://" + SHOP + "/admin/oauth/access_token", {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: "grant_type=client_credentials&client_id=" + encodeURIComponent(CLIENT_ID) + "&client_secret=" + encodeURIComponent(CLIENT_SECRET),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  var data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error("Token response is not valid JSON. HTTP " + code + ": " + text);
  }
  if (!data.access_token) throw new Error("Token failed. HTTP " + code + ": " + text);

  const newExpiry = Date.now() + ((Number(data.expires_in) || 3600) * 1000);
  props.setProperty(PROP_ACCESS_TOKEN, data.access_token);
  props.setProperty(PROP_TOKEN_EXPIRY, String(newExpiry));
  Logger.log("New token acquired");
  return data.access_token;
}

// ============================================================
// DATA — Parse rows from sheet
// ============================================================
function getValidRows_(sheet) {
  const data = sheet.getDataRange().getValues();
  const rows = [];
  for (var i = 1; i < data.length; i++) {
    const sku       = String(data[i][0] || "").trim();
    const qty       = parseInt(data[i][1], 10);
    const goodId    = String(data[i][2] || "").trim();
    const invItemIdRaw = String(data[i][3] || "").trim(); // col D — cached InventoryItemId
    // ตรวจ format: ต้องเป็น gid://shopify/InventoryItem/ตัวเลข เท่านั้น — ป้องกัน ID ผิดประเภท
    const invItemId = /^\/\/shopify\/InventoryItem\/\d+$/.test(invItemIdRaw.replace("gid:","")) ? invItemIdRaw : "";
    if (isNaN(qty)) continue;
    if (!sku && !goodId && !invItemId) continue;
    rows.push({ sku: sku, quantity: qty, goodId: goodId, inventoryItemId: invItemId, rowIndex: i + 1 });
  }
  return rows;
}

// ============================================================
// WRITE BACK — บันทึก InventoryItemId ลง sheet col D
//   ครั้งต่อไปจะ skip lookup ได้ทันที
// ============================================================
function writeBackInventoryItemIds_(sheet, updates) {
  updates.forEach(function(u) {
    sheet.getRange(u.rowIndex, INV_ITEM_ID_COL).setValue(u.inventoryItemId);
  });
  Logger.log("[CACHE] Wrote back " + updates.length + " InventoryItemIds to sheet col D");
}

function clearCachedInventoryItemIds_(sheet, rowIndices) {
  rowIndices.forEach(function(rowIndex) {
    sheet.getRange(rowIndex, INV_ITEM_ID_COL).clearContent();
  });
}

// รัน manual เพื่อ clear InventoryItemId cache ทั้งหมดใน col D แล้ว re-lookup ใหม่
function clearSheetInventoryItemIds() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log("[CACHE] Sheet '" + SHEET_NAME + "' is empty.");
    return;
  }
  const lastRow = sheet.getLastRow();
  sheet.getRange(2, INV_ITEM_ID_COL, lastRow - 1, 1).clearContent();
  Logger.log("[CACHE] Cleared all InventoryItemId cache from col D (" + (lastRow - 1) + " rows) — next run will re-lookup");
}

// ============================================================
// LOG — เขียนลง sheet "Log run script"
// ============================================================
function writeLog_(status, success, skip, message) {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOG_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(["Run Date","Started At","Finished At","Duration (sec)","Status","Success","Skipped","Message"]);
  }

  const props       = PropertiesService.getScriptProperties();
  const runDate     = props.getProperty(PROP_RUN_DATE)  || "";
  const startedAt   = props.getProperty(PROP_RUN_START) || "";
  const finishedAt  = new Date().toISOString();
  const durationSec = startedAt
    ? Math.round((new Date(finishedAt) - new Date(startedAt)) / 1000)
    : "";

  sheet.appendRow([runDate, startedAt, finishedAt, durationSec, status, success, skip, message]);
}

// ============================================================
// TRIGGER HELPERS
// ============================================================
function scheduleResume_() {
  clearResumeTriggers_();
  ScriptApp.newTrigger(RESUME_HANDLER).timeBased().after(RESUME_AFTER_MS).create();
  Logger.log("[SCHEDULED] Resume trigger set in " + (RESUME_AFTER_MS / 1000) + "s");
}

function clearResumeTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === RESUME_HANDLER; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });
}

// ============================================================
// STATE HELPERS
// ============================================================

// reset ทุกอย่าง รวมถึง RUN_STATUS (ใช้ตอนเริ่มวันใหม่หรือ manual reset)
function resetState_() {
  const props = PropertiesService.getScriptProperties();
  [PROP_NEXT_INDEX, PROP_TOTAL_SUCCESS, PROP_TOTAL_SKIP,
   PROP_IS_RUNNING, PROP_RUN_DATE, PROP_RUN_START, PROP_RUN_STATUS]
    .forEach(function(k) { props.deleteProperty(k); });
  clearResumeTriggers_();
}

// clear progress หลัง completed — เก็บ RUN_STATUS="completed" ไว้ให้ startDailyInventoryJob ตรวจสอบ
function clearState_() {
  const props = PropertiesService.getScriptProperties();
  [PROP_NEXT_INDEX, PROP_TOTAL_SUCCESS, PROP_TOTAL_SKIP,
   PROP_IS_RUNNING, PROP_RUN_START]   // คง PROP_RUN_DATE ไว้ เพื่อให้ startDailyInventoryJob ตรวจสอบ "completed" ได้ถูกต้อง
    .forEach(function(k) { props.deleteProperty(k); });
  clearResumeTriggers_();
}

// manual reset
function resetInventoryProgress() {
  resetState_();
  Logger.log("Inventory progress reset complete.");
}

// ============================================================
// MANUAL RUN — force start ได้เสมอ (ไม่ว่าจะ completed / failed / ค้าง)
//   Force-reset state ทั้งหมด แล้วเริ่มใหม่
//   (LockService ใน updateInventory จะป้องกัน concurrent run เอง)
// ============================================================
function manualRunInventoryJob() {
  const props = PropertiesService.getScriptProperties();
  const tz    = Session.getScriptTimeZone() || "Asia/Bangkok";

  Logger.log("[MANUAL] Force-resetting all state and starting job...");

  // Force clear ทุก property รวมถึง IS_RUNNING ที่อาจค้างอยู่
  resetState_();

  props.setProperty(PROP_RUN_DATE,   Utilities.formatDate(new Date(), tz, "yyyy-MM-dd"));
  props.setProperty(PROP_RUN_START,  new Date().toISOString());
  props.setProperty(PROP_RUN_STATUS, "running");

  updateInventory();
}

// ============================================================
// HELPERS
// ============================================================
function escapeGraphQLSearchValue_(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function getLocations() {
  const res = callGraphQL_("{ locations(first: 10) { edges { node { id name } } } }");
  if (res && res.data && res.data.locations) {
    res.data.locations.edges.forEach(function(l) {
      Logger.log(l.node.name + " → " + l.node.id);
    });
  }
}

function checkSKU() {
  const testSKU = "NTS1-NP70";
  const res = callGraphQL_('{ productVariants(first: 5, query: "sku:\'' + escapeGraphQLSearchValue_(testSKU) + '\'") { edges { node { sku displayName } } } }');
  Logger.log(JSON.stringify(res, null, 2));
}

function checkGoodId() {
  const testGoodId = "GID-001";
  Logger.log("[checkGoodId] Searching Good ID: " + testGoodId);

  let found = false;
  let cursor = null;
  let page = 0;

  do {
    page++;
    const afterClause = cursor ? ', after: "' + cursor + '"' : "";
    const rawQuery = [
      "{",
      '  products(first: 250' + afterClause + ') {',
      "    pageInfo { hasNextPage endCursor }",
      "    edges {",
      "      node {",
      "        title",
      '        metafield(namespace: "custom", key: "good_id") { value }',
      "        variants(first: 10) {",
      "          edges { node { sku inventoryItem { id } } }",
      "        }",
      "      }",
      "    }",
      "  }",
      "}"
    ].join("\n");

    const raw = callGraphQL_(rawQuery);

    if (!raw || !raw.data || !raw.data.products) {
      Logger.log("[checkGoodId] GraphQL error: " + JSON.stringify(raw, null, 2));
      break;
    }

    const edges = raw.data.products.edges;
    const pageInfo = raw.data.products.pageInfo;

    edges.forEach(function(e) {
      const node  = e.node;
      const mfVal = node.metafield ? node.metafield.value : null;

      if (mfVal === testGoodId) {
        found = true;
        Logger.log("[checkGoodId] ✅ FOUND — Product: " + node.title + " | good_id: " + mfVal);
        if (node.variants && node.variants.edges) {
          node.variants.edges.forEach(function(ve) {
            const v = ve.node;
            Logger.log("  → SKU: " + (v.sku || "(empty)") + " | InventoryItem: " + (v.inventoryItem ? v.inventoryItem.id : "(none)"));
          });
        }
      }
    });

    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;

  } while (cursor);

  if (!found) {
    Logger.log("[checkGoodId] ❌ NOT FOUND — ไม่พบ product ที่มี custom.good_id = '" + testGoodId + "'");
  }
}


function debugTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  Logger.log("Total triggers: " + triggers.length);
  triggers.forEach(function(t) {
    Logger.log(
      "Handler: " + t.getHandlerFunction() +
      " | Type: " + t.getEventType() +
      " | Source: " + t.getTriggerSource()
    );
  });
  
  const props = PropertiesService.getScriptProperties();
  Logger.log("IS_RUNNING: "  + props.getProperty("INV_IS_RUNNING"));
  Logger.log("RUN_STATUS: "  + props.getProperty("INV_RUN_STATUS"));
  Logger.log("RUN_DATE: "    + props.getProperty("INV_RUN_DATE"));
  Logger.log("NEXT_INDEX: "  + props.getProperty("INV_NEXT_INDEX"));
}

function getAllProductsWithGoodId() {
  let cursor = null;
  let allProducts = [];

  do {
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    const query = `
      {
        products(first: 250${afterClause}) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              title
              metafield(namespace: "custom", key: "good_id") { value }
              variants(first: 10) {
                edges {
                  node {
                    sku
                    inventoryItem { id }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const res = callGraphQL_(query);
    const products = res.data.products;

    products.edges.forEach(function(e) {
      const p = e.node;
      const goodId = p.metafield ? p.metafield.value : null;

      p.variants.edges.forEach(function(ve) {
        const v = ve.node;
        allProducts.push({
          productId: p.id,
          title: p.title,
          goodId: goodId,
          sku: v.sku,
          inventoryItemId: v.inventoryItem ? v.inventoryItem.id : null
        });
      });
    });

    cursor = products.pageInfo.hasNextPage ? products.pageInfo.endCursor : null;

  } while (cursor);

  Logger.log("Total variants: " + allProducts.length);
  Logger.log(JSON.stringify(allProducts, null, 2));
  return allProducts;
}
