// ============================================================
// CONFIG
// ============================================================
const SHOP = "sevenfive-4062.myshopify.com";
const CLIENT_ID = "696e1e9162c702cc07c2f94a1beacf8a";
const CLIENT_SECRET = "REDACTED_SECRET";
const LOCATION_ID = "gid://shopify/Location/85456027847";
const SHEET_NAME = "Inventory";
const LOG_SHEET_NAME = "Log run script";

const CHUNK_SIZE = 50;
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

const RESUME_HANDLER = "updateInventory";

// ============================================================
// DAILY ENTRY
// ============================================================
function startDailyInventoryJob() {
  const props     = PropertiesService.getScriptProperties();
  const tz        = Session.getScriptTimeZone() || "Asia/Bangkok";
  const todayKey  = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  const isRunning = props.getProperty(PROP_IS_RUNNING) === "true";
  const runDate   = props.getProperty(PROP_RUN_DATE);
  const runStatus = props.getProperty(PROP_RUN_STATUS);

  // กำลัง run อยู่ → skip
  if (isRunning) {
    Logger.log("[SKIP] Job is already running.");
    return;
  }

  // วันนี้ completed แล้ว → skip
  if (runDate === todayKey && runStatus === "completed") {
    Logger.log("[SKIP] Already completed for " + todayKey);
    return;
  }

  // วันใหม่ หรือ failed/ค้าง → reset แล้วเริ่มใหม่
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
        props.deleteProperty(PROP_IS_RUNNING); // ปลด lock ก่อน resume trigger จะยิง
        scheduleResume_();
        Logger.log("[PAUSE] Saved at index " + nextIndex + " — resume trigger scheduled");
        return;
      }

      // ── ดึง inventory item IDs ──
      const chunk = rows.slice(nextIndex, nextIndex + CHUNK_SIZE);
      let skuMap  = {};
      try {
        skuMap = getInventoryItemsBySKUs_(chunk.map(function(r) { return r.sku; }));
      } catch (err) {
        Logger.log("[ERROR] getInventoryItemsBySKUs_ at index " + nextIndex + ": " + err.message);
        totalSkip += chunk.length;
        nextIndex += CHUNK_SIZE;
        saveProgress_(props, nextIndex, totalSuccess, totalSkip);
        Utilities.sleep(2000);
        continue;
      }

      // ── จับคู่ SKU → quantity ──
      const quantities = [];
      chunk.forEach(function(r) {
        if (skuMap[r.sku]) {
          quantities.push({ inventoryItemId: skuMap[r.sku], quantity: r.quantity });
        } else {
          totalSkip++;
          Logger.log("[SKIP] SKU not found: " + r.sku);
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
            totalSkip += quantities.length;
          } else {
            totalSuccess += quantities.length;
            Logger.log("[OK] Updated " + quantities.length + " SKUs (index " + nextIndex + "–" + (nextIndex + chunk.length - 1) + ")");
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
    const sku = String(data[i][0] || "").trim();
    const qty = parseInt(data[i][1], 10);
    if (!sku || isNaN(qty)) continue;
    rows.push({ sku: sku, quantity: qty });
  }
  return rows;
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
   PROP_IS_RUNNING, PROP_RUN_DATE, PROP_RUN_START]
    .forEach(function(k) { props.deleteProperty(k); });
  clearResumeTriggers_();
}

// manual reset
function resetInventoryProgress() {
  resetState_();
  Logger.log("Inventory progress reset complete.");
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