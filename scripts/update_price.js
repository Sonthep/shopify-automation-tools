// ============================================================
// CONFIG
// ============================================================
const SHOP          = "sevenfive-4062.myshopify.com";
const CLIENT_ID     = "696e1e9162c702cc07c2f94a1beacf8a";
const CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("SHOPIFY_CLIENT_SECRET") || "";

const SHEET_NAME        = "Price Update";   // ชื่อ sheet ที่มีข้อมูลราคา
const LOG_SHEET_NAME    = "Log run script";


const COL_COMPARE_AT_PRICE = 3; // C — Compare At Price
const COL_PRICE            = 4; // D — Price
const COL_PRODUCT_GID      = 5; // E — Product GID
const COL_VARIANT_GID      = 6; // F — Variant GID

const CHUNK_SIZE     = 10;  // จำนวน product ต่อ batch (แต่ละ product อาจมีหลาย variant)
const MAX_RUNTIME_MS = 4.5 * 60 * 1000;
const RESUME_AFTER_MS = 60 * 1000;

const PROP_NEXT_INDEX    = "PRICE_NEXT_INDEX";
const PROP_TOTAL_SUCCESS = "PRICE_TOTAL_SUCCESS";
const PROP_TOTAL_SKIP    = "PRICE_TOTAL_SKIP";
const PROP_ACCESS_TOKEN  = "ACCESS_TOKEN";
const PROP_TOKEN_EXPIRY  = "TOKEN_EXPIRY";
const PROP_IS_RUNNING    = "PRICE_IS_RUNNING";
const PROP_RUN_DATE      = "PRICE_RUN_DATE";
const PROP_RUN_START     = "PRICE_RUN_START";
const PROP_RUN_STATUS    = "PRICE_RUN_STATUS";

const RESUME_HANDLER = "updatePrice";

// ============================================================
// MANUAL RUN
// ============================================================
function runPriceUpdateNow() {
  const props = PropertiesService.getScriptProperties();
  const tz    = Session.getScriptTimeZone() || "Asia/Bangkok";

  Logger.log("[MANUAL] Force-resetting all state and starting price update...");
  resetPriceState_();

  props.setProperty(PROP_RUN_DATE,   Utilities.formatDate(new Date(), tz, "yyyy-MM-dd"));
  props.setProperty(PROP_RUN_START,  new Date().toISOString());
  props.setProperty(PROP_RUN_STATUS, "running");

  updatePrice();
}

// ============================================================
// MAIN WORKER
// ============================================================
function updatePrice() {
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

    // อ่านและ group variants by Product GID
    const productGroups = getPriceRows_(sheet);
    const productIds    = Object.keys(productGroups);

    if (productIds.length === 0) {
      logPriceSuccess_(0, 0, "No data");
      return;
    }

    let nextIndex = Number(props.getProperty(PROP_NEXT_INDEX) || 0);
    Logger.log("[RUN] Total products: " + productIds.length + " | Start index: " + nextIndex);

    while (nextIndex < productIds.length) {

      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        savePriceProgress_(props, nextIndex, totalSuccess, totalSkip);
        props.deleteProperty(PROP_IS_RUNNING);
        schedulePriceResume_();
        Logger.log("[PAUSE] Saved at index " + nextIndex + " — resume trigger scheduled");
        return;
      }

      const chunk = productIds.slice(nextIndex, nextIndex + CHUNK_SIZE);

      for (var c = 0; c < chunk.length; c++) {
        const productId = chunk[c];
        const variants  = productGroups[productId];

        try {
          const result     = updateVariantPricesBatch_(productId, variants);
          const topErrors  = (result && result.errors) ? result.errors : [];
          const userErrors = (result && result.data && result.data.productVariantsBulkUpdate)
                             ? result.data.productVariantsBulkUpdate.userErrors : [];

          if (topErrors.length > 0) {
            Logger.log("[ERROR] GraphQL errors for product " + productId + ": " + JSON.stringify(topErrors));
            totalSkip += variants.length;
          } else if (userErrors.length > 0) {
            Logger.log("[ERROR] User errors for product " + productId + ": " + JSON.stringify(userErrors));
            totalSkip += variants.length;
          } else {
            totalSuccess += variants.length;
            Logger.log("[OK] Updated " + variants.length + " variant(s) for product: " + productId);
          }
        } catch (err) {
          Logger.log("[ERROR] updateVariantPricesBatch_ for " + productId + ": " + err.message);
          totalSkip += variants.length;
        }

        Utilities.sleep(500);
      }

      nextIndex += CHUNK_SIZE;
      savePriceProgress_(props, nextIndex, totalSuccess, totalSkip);
      Utilities.sleep(800);
    }

    Logger.log("[DONE] Success: " + totalSuccess + " variants | Skipped: " + totalSkip + " variants");
    logPriceSuccess_(totalSuccess, totalSkip, "Completed");

  } catch (err) {
    Logger.log("[EXCEPTION] " + err.message + "\n" + (err.stack || ""));
    logPriceFailed_(err, totalSuccess, totalSkip);
    props.deleteProperty(PROP_IS_RUNNING);
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// READ SHEET — group variants by Product GID
// ============================================================
function getPriceRows_(sheet) {
  const data   = sheet.getDataRange().getValues();
  const groups = {}; // productGid → [{ variantGid, price, compareAtPrice }]
  var skipped  = 0;

  for (var i = 1; i < data.length; i++) {
    const compareAtPrice = String(data[i][COL_COMPARE_AT_PRICE - 1] || "").trim();
    const price          = String(data[i][COL_PRICE - 1]            || "").trim();
    const productGid     = String(data[i][COL_PRODUCT_GID - 1]      || "").trim();
    const variantGid     = String(data[i][COL_VARIANT_GID - 1]      || "").trim();

    // ต้องมี Variant GID และ Price อย่างน้อย
    if (!variantGid || !price) {
      skipped++;
      continue;
    }
    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantGid)) {
      Logger.log("[SKIP] Invalid Variant GID at row " + (i + 1) + ": " + variantGid);
      skipped++;
      continue;
    }
    if (!productGid || !/^gid:\/\/shopify\/Product\/\d+$/.test(productGid)) {
      Logger.log("[SKIP] Invalid Product GID at row " + (i + 1) + ": " + productGid);
      skipped++;
      continue;
    }

    const priceNum          = parseFloat(price);
    const compareAtPriceNum = compareAtPrice ? parseFloat(compareAtPrice) : null;

    if (isNaN(priceNum)) {
      Logger.log("[SKIP] Invalid price at row " + (i + 1) + ": " + price);
      skipped++;
      continue;
    }

    if (!groups[productGid]) groups[productGid] = [];
    groups[productGid].push({
      variantGid:     variantGid,
      price:          priceNum.toFixed(2),
      compareAtPrice: (!isNaN(compareAtPriceNum) && compareAtPriceNum !== null)
                      ? compareAtPriceNum.toFixed(2)
                      : null
    });
  }

  if (skipped > 0) Logger.log("[PARSE] Skipped " + skipped + " invalid rows");
  Logger.log("[PARSE] " + Object.keys(groups).length + " products, " +
    Object.values(groups).reduce(function(s, v) { return s + v.length; }, 0) + " variants total");
  return groups;
}

// ============================================================
// BULK UPDATE PRICES — productVariantsBulkUpdate
// ============================================================
function updateVariantPricesBatch_(productId, variants) {
  const variantsGql = variants.map(function(v) {
    const compareAtLine = v.compareAtPrice !== null
      ? 'compareAtPrice: "' + v.compareAtPrice + '"'
      : 'compareAtPrice: null';
    return '{ id: "' + v.variantGid + '" price: "' + v.price + '" ' + compareAtLine + ' }';
  }).join("\n    ");

  const mutation =
    'mutation {\n' +
    '  productVariantsBulkUpdate(\n' +
    '    productId: "' + productId + '"\n' +
    '    variants: [\n    ' + variantsGql + '\n    ]\n' +
    '  ) {\n' +
    '    productVariants { id price compareAtPrice }\n' +
    '    userErrors { field message }\n' +
    '  }\n' +
    '}';

  return callGraphQL_(mutation);
}

// ============================================================
// SAVE PROGRESS
// ============================================================
function savePriceProgress_(props, nextIndex, totalSuccess, totalSkip) {
  props.setProperty(PROP_NEXT_INDEX,    String(nextIndex));
  props.setProperty(PROP_TOTAL_SUCCESS, String(totalSuccess));
  props.setProperty(PROP_TOTAL_SKIP,    String(totalSkip));
}

// ============================================================
// FINALIZE
// ============================================================
function logPriceSuccess_(totalSuccess, totalSkip, message) {
  writePriceLog_("SUCCESS", totalSuccess, totalSkip, message);
  PropertiesService.getScriptProperties().setProperty(PROP_RUN_STATUS, "completed");
  clearPriceState_();
  Logger.log("[OK] Price update completed and state cleared.");
}

function logPriceFailed_(error, totalSuccess, totalSkip) {
  const msg = (error && error.message) ? error.message : String(error);
  writePriceLog_("FAILED", totalSuccess, totalSkip, msg);
  PropertiesService.getScriptProperties().setProperty(PROP_RUN_STATUS, "failed");
}

// ============================================================
// LOG SHEET
// ============================================================
function writePriceLog_(status, success, skip, message) {
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
// TRIGGER / RESUME
// ============================================================
function schedulePriceResume_() {
  clearPriceResumeTriggers_();
  ScriptApp.newTrigger(RESUME_HANDLER).timeBased().after(RESUME_AFTER_MS).create();
  Logger.log("[SCHEDULED] Price resume trigger set in " + (RESUME_AFTER_MS / 1000) + "s");
}

function clearPriceResumeTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === RESUME_HANDLER; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });
}

// ============================================================
// STATE HELPERS
// ============================================================
function resetPriceState_() {
  const props = PropertiesService.getScriptProperties();
  [PROP_NEXT_INDEX, PROP_TOTAL_SUCCESS, PROP_TOTAL_SKIP,
   PROP_IS_RUNNING, PROP_RUN_DATE, PROP_RUN_START, PROP_RUN_STATUS]
    .forEach(function(k) { props.deleteProperty(k); });
  clearPriceResumeTriggers_();
}

function clearPriceState_() {
  const props = PropertiesService.getScriptProperties();
  [PROP_NEXT_INDEX, PROP_TOTAL_SUCCESS, PROP_TOTAL_SKIP,
   PROP_IS_RUNNING, PROP_RUN_START]
    .forEach(function(k) { props.deleteProperty(k); });
  clearPriceResumeTriggers_();
}

function resetPriceProgress() {
  resetPriceState_();
  Logger.log("Price update progress reset complete.");
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
      Utilities.sleep(RETRY_DELAY_MS[retryCount]);
      return callGraphQL_(query, retryCount + 1);
    }
    throw new Error("Fetch failed after " + MAX_RETRIES + " retries: " + fetchErr.message);
  }

  const code = res.getResponseCode();
  const text = res.getContentText();

  if (RETRYABLE_CODES.indexOf(code) !== -1) {
    if (retryCount < MAX_RETRIES) {
      Logger.log("[RETRY " + (retryCount+1) + "/" + MAX_RETRIES + "] HTTP " + code);
      Utilities.sleep(RETRY_DELAY_MS[retryCount]);
      return callGraphQL_(query, retryCount + 1);
    }
    throw new Error("GraphQL HTTP " + code + " after " + MAX_RETRIES + " retries");
  }

  if (code >= 400) throw new Error("GraphQL HTTP " + code + ": " + text.substring(0, 500));

  var json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    if (retryCount < MAX_RETRIES) {
      Utilities.sleep(RETRY_DELAY_MS[retryCount]);
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
    payload: "grant_type=client_credentials&client_id=" + encodeURIComponent(CLIENT_ID) +
             "&client_secret=" + encodeURIComponent(CLIENT_SECRET),
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
// ============================================================
// PRICE UPDATE — NO DISCOUNT
//   Sheet: "Price Update No Discout"
//   Columns: B=Price | C=Product GID | D=Variant GID
//   → อัปเดตเฉพาะ price, ล้าง compareAtPrice เป็น null
// ============================================================
// ============================================================

const ND_SHEET_NAME   = "Price Update No Discout";  // ชื่อ sheet (ตรงกับ tab จริง)

// คอลัมน์ใน sheet No Discount (1-based)
const ND_COL_PRICE       = 3; // C — Price
const ND_COL_PRODUCT_GID = 4; // D — Product GID
const ND_COL_VARIANT_GID = 5; // E — Variant GID

const ND_PROP_NEXT_INDEX    = "ND_NEXT_INDEX";
const ND_PROP_TOTAL_SUCCESS = "ND_TOTAL_SUCCESS";
const ND_PROP_TOTAL_SKIP    = "ND_TOTAL_SKIP";
const ND_PROP_IS_RUNNING    = "ND_IS_RUNNING";
const ND_PROP_RUN_DATE      = "ND_RUN_DATE";
const ND_PROP_RUN_START     = "ND_RUN_START";
const ND_PROP_RUN_STATUS    = "ND_RUN_STATUS";

const ND_RESUME_HANDLER = "updatePriceNoDiscount";

// ============================================================
// MANUAL RUN — No Discount
// ============================================================
function runPriceNoDiscountNow() {
  const props = PropertiesService.getScriptProperties();
  const tz    = Session.getScriptTimeZone() || "Asia/Bangkok";

  Logger.log("[MANUAL-ND] Force-resetting state and starting no-discount price update...");
  resetNdState_();

  props.setProperty(ND_PROP_RUN_DATE,   Utilities.formatDate(new Date(), tz, "yyyy-MM-dd"));
  props.setProperty(ND_PROP_RUN_START,  new Date().toISOString());
  props.setProperty(ND_PROP_RUN_STATUS, "running");

  updatePriceNoDiscount();
}

// ============================================================
// MAIN WORKER — No Discount
// ============================================================
function updatePriceNoDiscount() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    Logger.log("[SKIP] Another process is running");
    return;
  }

  const startTime  = Date.now();
  const props      = PropertiesService.getScriptProperties();
  let totalSuccess = Number(props.getProperty(ND_PROP_TOTAL_SUCCESS) || 0);
  let totalSkip    = Number(props.getProperty(ND_PROP_TOTAL_SKIP)    || 0);

  try {
    props.setProperty(ND_PROP_IS_RUNNING, "true");

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ND_SHEET_NAME);
    if (!sheet) throw new Error('Sheet "' + ND_SHEET_NAME + '" not found');

    const productGroups = getNdPriceRows_(sheet);
    const productIds    = Object.keys(productGroups);

    if (productIds.length === 0) {
      logNdSuccess_(0, 0, "No data");
      return;
    }

    let nextIndex = Number(props.getProperty(ND_PROP_NEXT_INDEX) || 0);
    Logger.log("[RUN-ND] Total products: " + productIds.length + " | Start index: " + nextIndex);

    while (nextIndex < productIds.length) {

      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        saveNdProgress_(props, nextIndex, totalSuccess, totalSkip);
        props.deleteProperty(ND_PROP_IS_RUNNING);
        scheduleNdResume_();
        Logger.log("[PAUSE-ND] Saved at index " + nextIndex + " — resume trigger scheduled");
        return;
      }

      const chunk = productIds.slice(nextIndex, nextIndex + CHUNK_SIZE);

      for (var c = 0; c < chunk.length; c++) {
        const productId = chunk[c];
        const variants  = productGroups[productId];

        try {
          const result     = updateVariantPricesNoBatch_(productId, variants);
          const topErrors  = (result && result.errors) ? result.errors : [];
          const userErrors = (result && result.data && result.data.productVariantsBulkUpdate)
                             ? result.data.productVariantsBulkUpdate.userErrors : [];

          if (topErrors.length > 0) {
            Logger.log("[ERROR-ND] GraphQL errors for product " + productId + ": " + JSON.stringify(topErrors));
            totalSkip += variants.length;
          } else if (userErrors.length > 0) {
            Logger.log("[ERROR-ND] User errors for product " + productId + ": " + JSON.stringify(userErrors));
            totalSkip += variants.length;
          } else {
            totalSuccess += variants.length;
            Logger.log("[OK-ND] Updated " + variants.length + " variant(s) for product: " + productId);
          }
        } catch (err) {
          Logger.log("[ERROR-ND] updateVariantPricesNoBatch_ for " + productId + ": " + err.message);
          totalSkip += variants.length;
        }

        Utilities.sleep(500);
      }

      nextIndex += CHUNK_SIZE;
      saveNdProgress_(props, nextIndex, totalSuccess, totalSkip);
      Utilities.sleep(800);
    }

    Logger.log("[DONE-ND] Success: " + totalSuccess + " variants | Skipped: " + totalSkip + " variants");
    logNdSuccess_(totalSuccess, totalSkip, "Completed");

  } catch (err) {
    Logger.log("[EXCEPTION-ND] " + err.message + "\n" + (err.stack || ""));
    logNdFailed_(err, totalSuccess, totalSkip);
    props.deleteProperty(ND_PROP_IS_RUNNING);
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// READ SHEET — No Discount (B=Price, C=Product GID, D=Variant GID)
// ============================================================
function getNdPriceRows_(sheet) {
  const data   = sheet.getDataRange().getValues();
  const groups = {};
  var skipped  = 0;

  for (var i = 1; i < data.length; i++) {
    const price      = String(data[i][ND_COL_PRICE - 1]       || "").trim();
    const productGid = String(data[i][ND_COL_PRODUCT_GID - 1] || "").trim();
    const variantGid = String(data[i][ND_COL_VARIANT_GID - 1] || "").trim();

    if (!variantGid || !price) { skipped++; continue; }

    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantGid)) {
      Logger.log("[SKIP-ND] Invalid Variant GID at row " + (i + 1) + ": " + variantGid);
      skipped++; continue;
    }
    if (!productGid || !/^gid:\/\/shopify\/Product\/\d+$/.test(productGid)) {
      Logger.log("[SKIP-ND] Invalid Product GID at row " + (i + 1) + ": " + productGid);
      skipped++; continue;
    }

    const priceNum = parseFloat(price);
    if (isNaN(priceNum)) {
      Logger.log("[SKIP-ND] Invalid price at row " + (i + 1) + ": " + price);
      skipped++; continue;
    }

    if (!groups[productGid]) groups[productGid] = [];
    groups[productGid].push({
      variantGid: variantGid,
      price:      priceNum.toFixed(2)
    });
  }

  if (skipped > 0) Logger.log("[PARSE-ND] Skipped " + skipped + " invalid rows");
  Logger.log("[PARSE-ND] " + Object.keys(groups).length + " products, " +
    Object.values(groups).reduce(function(s, v) { return s + v.length; }, 0) + " variants total");
  return groups;
}

// ============================================================
// BULK UPDATE — price only, compareAtPrice → null
// ============================================================
function updateVariantPricesNoBatch_(productId, variants) {
  const variantsGql = variants.map(function(v) {
    return '{ id: "' + v.variantGid + '" price: "' + v.price + '" compareAtPrice: null }';
  }).join("\n    ");

  const mutation =
    'mutation {\n' +
    '  productVariantsBulkUpdate(\n' +
    '    productId: "' + productId + '"\n' +
    '    variants: [\n    ' + variantsGql + '\n    ]\n' +
    '  ) {\n' +
    '    productVariants { id price compareAtPrice }\n' +
    '    userErrors { field message }\n' +
    '  }\n' +
    '}';

  return callGraphQL_(mutation);
}

// ============================================================
// SAVE PROGRESS — No Discount
// ============================================================
function saveNdProgress_(props, nextIndex, totalSuccess, totalSkip) {
  props.setProperty(ND_PROP_NEXT_INDEX,    String(nextIndex));
  props.setProperty(ND_PROP_TOTAL_SUCCESS, String(totalSuccess));
  props.setProperty(ND_PROP_TOTAL_SKIP,    String(totalSkip));
}

// ============================================================
// FINALIZE — No Discount
// ============================================================
function logNdSuccess_(totalSuccess, totalSkip, message) {
  writeNdLog_("SUCCESS", totalSuccess, totalSkip, message);
  PropertiesService.getScriptProperties().setProperty(ND_PROP_RUN_STATUS, "completed");
  clearNdState_();
  Logger.log("[OK-ND] Job completed and state cleared.");
}

function logNdFailed_(error, totalSuccess, totalSkip) {
  const msg = (error && error.message) ? error.message : String(error);
  writeNdLog_("FAILED", totalSuccess, totalSkip, msg);
  PropertiesService.getScriptProperties().setProperty(ND_PROP_RUN_STATUS, "failed");
}

function writeNdLog_(status, success, skip, message) {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOG_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(["Run Date","Started At","Finished At","Duration (sec)","Status","Success","Skipped","Message"]);
  }

  const props       = PropertiesService.getScriptProperties();
  const runDate     = props.getProperty(ND_PROP_RUN_DATE)  || "";
  const startedAt   = props.getProperty(ND_PROP_RUN_START) || "";
  const finishedAt  = new Date().toISOString();
  const durationSec = startedAt
    ? Math.round((new Date(finishedAt) - new Date(startedAt)) / 1000)
    : "";

  sheet.appendRow([runDate, startedAt, finishedAt, durationSec, "[ND] " + status, success, skip, message]);
}

// ============================================================
// TRIGGER / RESUME — No Discount
// ============================================================
function scheduleNdResume_() {
  clearNdResumeTriggers_();
  ScriptApp.newTrigger(ND_RESUME_HANDLER).timeBased().after(RESUME_AFTER_MS).create();
  Logger.log("[SCHEDULED-ND] Resume trigger set in " + (RESUME_AFTER_MS / 1000) + "s");
}

function clearNdResumeTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === ND_RESUME_HANDLER; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });
}

// ============================================================
// STATE HELPERS — No Discount
// ============================================================
function resetNdState_() {
  const props = PropertiesService.getScriptProperties();
  [ND_PROP_NEXT_INDEX, ND_PROP_TOTAL_SUCCESS, ND_PROP_TOTAL_SKIP,
   ND_PROP_IS_RUNNING, ND_PROP_RUN_DATE, ND_PROP_RUN_START, ND_PROP_RUN_STATUS]
    .forEach(function(k) { props.deleteProperty(k); });
  clearNdResumeTriggers_();
}

function clearNdState_() {
  const props = PropertiesService.getScriptProperties();
  [ND_PROP_NEXT_INDEX, ND_PROP_TOTAL_SUCCESS, ND_PROP_TOTAL_SKIP,
   ND_PROP_IS_RUNNING, ND_PROP_RUN_START]
    .forEach(function(k) { props.deleteProperty(k); });
  clearNdResumeTriggers_();
}

function resetNdProgress() {
  resetNdState_();
  Logger.log("No-discount price update progress reset complete.");
}

// ============================================================
// ============================================================
// BULK OPERATIONS — เร็วกว่ามาก สำหรับหมื่น+ rows
//
//   วิธีทำงาน:
//     1. อ่าน sheet → build JSONL (1 บรรทัด = 1 variant)
//     2. stagedUploadsCreate  → รับ upload URL จาก Shopify
//     3. PUT JSONL ไปที่ URL  → upload ไฟล์ครั้งเดียว
//     4. bulkOperationRunMutation → Shopify ประมวลผล async
//     5. pollBulkPriceOperation (trigger ทุก 1 นาที) → ตรวจ status
//
//   รองรับ 2 sheet:
//     runBulkPriceNow()           → "Price Update"          (มี compareAtPrice)
//     runBulkPriceNoDiscountNow() → "Price Update No Discout" (ล้าง compareAtPrice)
// ============================================================
// ============================================================

const BULK_PROP_OPERATION_ID = "BULK_OP_ID";
const BULK_PROP_RUN_START    = "BULK_RUN_START";
const BULK_PROP_TOTAL_ROWS   = "BULK_TOTAL_ROWS";
const BULK_POLL_HANDLER      = "pollBulkPriceOperation";
const BULK_POLL_INTERVAL_MS  = 60 * 1000; // poll ทุก 1 นาที

// ============================================================
// ENTRY POINTS
// ============================================================
function runBulkPriceNow() {
  // "Price Update": B=CompareAtPrice | C=Price | D=ProductGID | E=VariantGID
  startBulkPriceJob_(SHEET_NAME, true);
}

function runBulkPriceNoDiscountNow() {
  // "Price Update No Discout": B=Price | C=ProductGID | D=VariantGID
  startBulkPriceJob_(ND_SHEET_NAME, false);
}

// ============================================================
// START BULK JOB
// ============================================================
function startBulkPriceJob_(sheetName, hasDiscount) {
  clearBulkPollTriggers_();

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet "' + sheetName + '" not found');

  // 1. build JSONL
  const lines = buildPriceJsonl_(sheet, hasDiscount);
  if (lines.length === 0) {
    Logger.log("[BULK] No valid rows found — aborting");
    return;
  }
  const jsonlContent = lines.join("\n");
  Logger.log("[BULK] Built JSONL: " + lines.length + " rows, " + jsonlContent.length + " bytes");

  // 2. get staged upload URL
  const uploadInfo  = createStagedUpload_();
  const uploadUrl   = uploadInfo.url;
  const resourceUrl = uploadInfo.resourceUrl;
  const params      = uploadInfo.parameters; // [{name, value}]

  // 3. PUT JSONL
  uploadJsonl_(uploadUrl, params, jsonlContent);
  Logger.log("[BULK] JSONL uploaded to staged URL");

  // 4. start bulk operation
  const mutationStr =
    "mutation bulkUpdateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {" +
    "  productVariantsBulkUpdate(productId: $productId, variants: $variants) {" +
    "    productVariants { id price compareAtPrice }" +
    "    userErrors { field message }" +
    "  }" +
    "}";

  const operationId = startBulkOperation_(mutationStr, resourceUrl);
  Logger.log("[BULK] Operation started: " + operationId);

  // 5. save state + schedule poll
  const props = PropertiesService.getScriptProperties();
  props.setProperty(BULK_PROP_OPERATION_ID, operationId);
  props.setProperty(BULK_PROP_RUN_START,    new Date().toISOString());
  props.setProperty(BULK_PROP_TOTAL_ROWS,   String(lines.length));

  ScriptApp.newTrigger(BULK_POLL_HANDLER).timeBased().after(BULK_POLL_INTERVAL_MS).create();
  Logger.log("[BULK] Poll trigger scheduled in 60s — ดู status ใน Log run script");
}

// ============================================================
// BUILD JSONL
// ============================================================
function buildPriceJsonl_(sheet, hasDiscount) {
  const data  = sheet.getDataRange().getValues();
  const lines = [];
  var skipped = 0;

  for (var i = 1; i < data.length; i++) {
    var price, productGid, variantGid, compareAtPrice;

    if (hasDiscount) {
      compareAtPrice = String(data[i][COL_COMPARE_AT_PRICE - 1] || "").trim();
      price          = String(data[i][COL_PRICE - 1]            || "").trim();
      productGid     = String(data[i][COL_PRODUCT_GID - 1]      || "").trim();
      variantGid     = String(data[i][COL_VARIANT_GID - 1]      || "").trim();
    } else {
      price      = String(data[i][ND_COL_PRICE - 1]       || "").trim();
      productGid = String(data[i][ND_COL_PRODUCT_GID - 1] || "").trim();
      variantGid = String(data[i][ND_COL_VARIANT_GID - 1] || "").trim();
    }

    if (!variantGid || !price || !productGid) { skipped++; continue; }
    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantGid)) { skipped++; continue; }
    if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productGid)) { skipped++; continue; }

    const priceNum = parseFloat(price);
    if (isNaN(priceNum)) { skipped++; continue; }

    const variantInput = { id: variantGid, price: priceNum.toFixed(2) };

    if (hasDiscount) {
      const capNum = parseFloat(compareAtPrice);
      variantInput.compareAtPrice = (!isNaN(capNum) && compareAtPrice !== "") ? capNum.toFixed(2) : null;
    } else {
      variantInput.compareAtPrice = null;
    }

    // JSONL format สำหรับ productVariantsBulkUpdate: 1 line = 1 variant
    lines.push(JSON.stringify({ productId: productGid, variants: [variantInput] }));
  }

  if (skipped > 0) Logger.log("[BULK] Skipped " + skipped + " invalid rows");
  return lines;
}

// ============================================================
// STAGED UPLOAD — ขอ URL จาก Shopify
// ============================================================
function createStagedUpload_() {
  const mutation =
    "mutation {" +
    "  stagedUploadsCreate(input: [{" +
    '    resource: BULK_MUTATION_VARIABLES,' +
    '    filename: "price_update.jsonl",' +
    '    mimeType: "text/jsonl",' +
    "    httpMethod: PUT" +
    "  }]) {" +
    "    stagedTargets { url resourceUrl parameters { name value } }" +
    "    userErrors { field message }" +
    "  }" +
    "}";

  const res = callGraphQL_(mutation);
  if (res.errors) throw new Error("stagedUploadsCreate error: " + JSON.stringify(res.errors));

  const ue = res.data.stagedUploadsCreate.userErrors;
  if (ue && ue.length > 0) throw new Error("stagedUploadsCreate userErrors: " + JSON.stringify(ue));

  const targets = res.data.stagedUploadsCreate.stagedTargets;
  if (!targets || targets.length === 0) throw new Error("No staged targets returned");

  return targets[0]; // { url, resourceUrl, parameters }
}

// ============================================================
// PUT JSONL FILE
// ============================================================
function uploadJsonl_(url, parameters, content) {
  const headers = { "Content-Type": "text/jsonl" };
  parameters.forEach(function(p) { headers[p.name] = p.value; });

  const res = UrlFetchApp.fetch(url, {
    method: "put",
    headers: headers,
    payload: content,
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("Upload failed HTTP " + code + ": " + res.getContentText().substring(0, 300));
  }
}

// ============================================================
// START BULK OPERATION
// ============================================================
function startBulkOperation_(mutationStr, stagedUploadPath) {
  const gql =
    "mutation {" +
    "  bulkOperationRunMutation(" +
    "    mutation: " + JSON.stringify(mutationStr) + "," +
    "    stagedUploadPath: " + JSON.stringify(stagedUploadPath) +
    "  ) {" +
    "    bulkOperation { id status }" +
    "    userErrors { field message }" +
    "  }" +
    "}";

  const res = callGraphQL_(gql);
  if (res.errors) throw new Error("bulkOperationRunMutation error: " + JSON.stringify(res.errors));

  const opRes = res.data.bulkOperationRunMutation;
  if (opRes.userErrors && opRes.userErrors.length > 0) {
    throw new Error("bulkOperationRunMutation userErrors: " + JSON.stringify(opRes.userErrors));
  }

  return opRes.bulkOperation.id;
}

// ============================================================
// POLL — ตรวจ status (trigger เรียกทุก 1 นาที)
// ============================================================
function pollBulkPriceOperation() {
  clearBulkPollTriggers_();

  const props       = PropertiesService.getScriptProperties();
  const operationId = props.getProperty(BULK_PROP_OPERATION_ID);
  const totalRows   = props.getProperty(BULK_PROP_TOTAL_ROWS) || "?";
  const startedAt   = props.getProperty(BULK_PROP_RUN_START)  || "";

  if (!operationId) {
    Logger.log("[POLL] No active bulk operation");
    return;
  }

  const statusRes = callGraphQL_(
    "{ currentBulkOperation(type: MUTATION) { id status errorCode objectCount url } }"
  );

  if (!statusRes || !statusRes.data || !statusRes.data.currentBulkOperation) {
    Logger.log("[POLL] Could not get status — rescheduling");
    ScriptApp.newTrigger(BULK_POLL_HANDLER).timeBased().after(BULK_POLL_INTERVAL_MS).create();
    return;
  }

  const op = statusRes.data.currentBulkOperation;
  Logger.log("[POLL] Status: " + op.status + " | Processed: " + op.objectCount + "/" + totalRows);

  // ยังทำงานอยู่ → รอ poll รอบหน้า
  if (op.status === "RUNNING" || op.status === "CREATED") {
    ScriptApp.newTrigger(BULK_POLL_HANDLER).timeBased().after(BULK_POLL_INTERVAL_MS).create();
    return;
  }

  // terminal state
  const durationSec = startedAt
    ? Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)
    : "";

  if (op.status === "COMPLETED") {
    Logger.log("[BULK] COMPLETED — " + op.objectCount + " variants in " + durationSec + "s");
    writeBulkLog_("SUCCESS", op.objectCount, 0,
      "Bulk done in " + durationSec + "s | Result: " + (op.url || "-"), startedAt);
  } else {
    Logger.log("[BULK] " + op.status + " — errorCode: " + (op.errorCode || "-"));
    writeBulkLog_(op.status, 0, totalRows,
      "errorCode: " + (op.errorCode || "-"), startedAt);
  }

  // clean up
  [BULK_PROP_OPERATION_ID, BULK_PROP_RUN_START, BULK_PROP_TOTAL_ROWS]
    .forEach(function(k) { props.deleteProperty(k); });
}

// ============================================================
// CANCEL BULK OPERATION — ใช้เมื่อต้องการหยุดกลางคัน
// ============================================================
function cancelBulkPriceOperation() {
  clearBulkPollTriggers_();
  const props = PropertiesService.getScriptProperties();
  const id    = props.getProperty(BULK_PROP_OPERATION_ID);
  if (!id) { Logger.log("[BULK] No active operation to cancel"); return; }

  const gql = 'mutation { bulkOperationCancel(id: ' + JSON.stringify(id) + ') { bulkOperation { id status } userErrors { field message } } }';
  const res  = callGraphQL_(gql);
  Logger.log("[BULK] Cancel result: " + JSON.stringify(res));

  [BULK_PROP_OPERATION_ID, BULK_PROP_RUN_START, BULK_PROP_TOTAL_ROWS]
    .forEach(function(k) { props.deleteProperty(k); });
}

// ============================================================
// HELPERS
// ============================================================
function clearBulkPollTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === BULK_POLL_HANDLER; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });
}

function writeBulkLog_(status, success, skip, message, startedAt) {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(["Run Date","Started At","Finished At","Duration (sec)","Status","Success","Skipped","Message"]);
  }
  const tz         = Session.getScriptTimeZone() || "Asia/Bangkok";
  const finishedAt = new Date().toISOString();
  const duration   = startedAt
    ? Math.round((new Date(finishedAt) - new Date(startedAt)) / 1000)
    : "";
  sheet.appendRow([
    Utilities.formatDate(new Date(), tz, "yyyy-MM-dd"),
    startedAt, finishedAt, duration,
    "[BULK] " + status, success, skip, message
  ]);
}
