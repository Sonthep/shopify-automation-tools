// ============================================================
// CONFIG (ตั้งค่าผ่าน Script Properties ใน Apps Script Editor)
// ============================================================
var SHOP          = PropertiesService.getScriptProperties().getProperty("SHOP")          || "your-store.myshopify.com";
var CLIENT_ID     = PropertiesService.getScriptProperties().getProperty("CLIENT_ID")     || "";
var CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("CLIENT_SECRET") || "";

var EXPORT_SHEET_NAME = "Products Export";
var CHUNK_SIZE        = 5 * 1024 * 1024; // 5 MB per chunk
var POLL_INTERVAL_MS  = 10000;           // เช็คสถานะทุก 10 วินาที

// Property keys
var PROP_ACCESS_TOKEN = "ACCESS_TOKEN";
var PROP_TOKEN_EXPIRY = "TOKEN_EXPIRY";

// ============================================================
// MAIN FUNCTION — กด Run เพื่อเริ่ม Export
// ============================================================
function exportProductsToSheet() {
  // 1. เช็คว่ามี Bulk Operation ที่เสร็จแล้วหรือกำลังทำงานอยู่ไหม
  var currentOp = getCurrentBulkOp_();
  Logger.log("Current bulk op: " + JSON.stringify(currentOp));

  if (currentOp && currentOp.status === "COMPLETED" && currentOp.url) {
    Logger.log("✅ Found completed bulk op, downloading now...");
    processAndWrite_(currentOp.url);
    return;
  }

  if (currentOp && (currentOp.status === "RUNNING" || currentOp.status === "CREATED")) {
    Logger.log("⏳ Bulk op already running: " + currentOp.id + ". Waiting...");
    var result = waitForCompletion_(currentOp.id);
    if (result.url) processAndWrite_(result.url);
    else Logger.log("❌ Bulk op did not complete: " + result.status);
    return;
  }

  // 2. สร้าง Bulk Query ใหม่
  Logger.log("🚀 Starting new bulk query...");
  var opId = startBulkQuery_();
  if (!opId) {
    Logger.log("❌ Failed to start bulk query. Check logs above.");
    return;
  }

  // 3. รอให้เสร็จ
  var result = waitForCompletion_(opId);
  if (result.url) {
    processAndWrite_(result.url);
  } else {
    Logger.log("❌ Bulk op ended with status: " + result.status);
  }
}

// ============================================================
// GET CURRENT BULK OPERATION
// ============================================================
function getCurrentBulkOp_() {
  var res = callGraphQL_({ query: "{ currentBulkOperation(type: QUERY) { id status url } }" });
  return (res && res.data) ? res.data.currentBulkOperation : null;
}

// ============================================================
// START BULK QUERY
// ============================================================
function startBulkQuery_() {
  var innerQuery = [
    "{",
    "  products {",
    "    edges {",
    "      node {",
    "        id handle title vendor productType tags status publishedAt",
    "        variants { edges { node {",
    "          id sku price compareAtPrice inventoryQuantity",
    "          inventoryItem { id }",
    "        } } }",
    "        images(first: 1) { edges { node { id url } } }",
    "        metafields { edges { node { namespace key value } } }",
    "      }",
    "    }",
    "  }",
    "}"
  ].join("\n");

  var mutation = [
    "mutation BulkQuery($query: String!) {",
    "  bulkOperationRunQuery(query: $query) {",
    "    bulkOperation { id status }",
    "    userErrors { field message }",
    "  }",
    "}"
  ].join("\n");

  var res = callGraphQL_({ query: mutation, variables: { query: innerQuery } });

  if (!res || !res.data || !res.data.bulkOperationRunQuery) {
    Logger.log("[ERROR] startBulkQuery_ response: " + JSON.stringify(res));
    return null;
  }

  var opData = res.data.bulkOperationRunQuery;
  if (opData.userErrors && opData.userErrors.length > 0) {
    Logger.log("[ERROR] userErrors: " + JSON.stringify(opData.userErrors));
    return null;
  }

  return opData.bulkOperation.id;
}

// ============================================================
// WAIT FOR BULK OPERATION TO COMPLETE (max 5 minutes)
// ============================================================
function waitForCompletion_(opId) {
  var query = [
    "query GetBulkOp($id: ID!) {",
    "  node(id: $id) {",
    "    ... on BulkOperation {",
    "      id status url errorCode objectCount",
    "    }",
    "  }",
    "}"
  ].join("\n");

  var startTime  = Date.now();
  var MAX_WAIT   = 5 * 60 * 1000; // 5 minutes

  while (true) {
    Utilities.sleep(POLL_INTERVAL_MS);

    var res = callGraphQL_({ query: query, variables: { id: opId } });
    var op  = (res && res.data && res.data.node) ? res.data.node : null;

    if (!op) {
      Logger.log("[ERROR] Bulk operation not found: " + opId);
      return { status: "NOT_FOUND" };
    }

    Logger.log("  [" + op.status + "] objectCount=" + op.objectCount);

    if (op.status === "COMPLETED")                          return { status: "COMPLETED", url: op.url };
    if (op.status === "FAILED" || op.status === "CANCELED") return { status: op.status };

    if (Date.now() - startTime > MAX_WAIT) {
      Logger.log("⏳ Still running after 5 min. Run again to continue.");
      return { status: op.status };
    }
  }
}

// ============================================================
// DOWNLOAD JSONL → PARSE → WRITE TO SHEET
// ============================================================
function processAndWrite_(url) {
  Logger.log("📥 Downloading JSONL in 5 MB chunks...");

  var products = {}; // gid → product object
  var variants = {}; // productGid → [variant objects]
  var images   = {}; // productGid → [image url strings]
  var meta     = {}; // gid (product or variant) → { "ns.key": value }

  // ---- DOWNLOAD LOOP ----------------------------------------
  var startByte   = 0;
  var leftover    = "";  // บรรทัดที่ถูกตัดครึ่งระหว่าง chunk
  var totalLines  = 0;

  while (true) {
    var endByte = startByte + CHUNK_SIZE - 1;
    Logger.log("  Fetching bytes " + startByte + "-" + endByte + "...");

    var res  = UrlFetchApp.fetch(url, {
      headers: { "Range": "bytes=" + startByte + "-" + endByte },
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();

    // 416 = Range Not Satisfiable → ปลายไฟล์แล้ว
    if (code === 416) {
      if (leftover.trim()) {
        parseLine_(leftover, products, variants, images, meta);
        totalLines++;
      }
      break;
    }

    if (code >= 400) {
      Logger.log("[ERROR] HTTP " + code + ": " + res.getContentText().substring(0, 300));
      break;
    }

    var bytes = res.getContent();
    if (!bytes || bytes.length === 0) break;

    // code 200 = เซิร์ฟเวอร์ส่งไฟล์เต็มมาเลย | bytes < CHUNK_SIZE = chunk สุดท้าย
    var isLastChunk = (code === 200 || bytes.length < CHUNK_SIZE);

    // รวม leftover จาก chunk ที่แล้ว แล้วแปลง byte → text
    var text  = leftover + Utilities.newBlob(bytes).getDataAsString("UTF-8");
    var lines = text.split("\n");

    if (!isLastChunk) {
      // เก็บบรรทัดสุดท้ายที่อาจถูกตัดครึ่งไว้รอ chunk ถัดไป
      leftover = lines.pop() || "";
    } else {
      leftover = "";
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      totalLines++;
      parseLine_(line, products, variants, images, meta);
    }

    if (isLastChunk) break;
    startByte += bytes.length; // เลื่อนไปยัง chunk ถัดไป
  }

  Logger.log("✅ " + totalLines + " lines parsed.");

  // ---- ASSEMBLE ROWS ----------------------------------------
  var HEADERS = [
    "custom.good_id",
    "Variant SKU",
    "Product GID",
    "Variant GID",
    "Inventory Item ID",
    "Handle",
    "Title",
    "Vendor",
    "Type",
    "Tags",
    "Status",
    "Published",
    "Price",
    "Compare At Price",
    "Inventory",
    "Image Src",
    "custom.spapart_or_product"
  ];

  var rows = [HEADERS];
  var productIds = Object.keys(products);

  for (var pi = 0; pi < productIds.length; pi++) {
    var pid      = productIds[pi];
    var p        = products[pid];
    var pMeta    = meta[pid]     || {};
    var pVars    = variants[pid] || [{}]; // ถ้าไม่มี variant ก็เขียน 1 แถวว่าง
    var pImgs    = images[pid]   || [];
    var imgSrc   = pImgs.length > 0 ? pImgs[0] : "";

    for (var vi = 0; vi < pVars.length; vi++) {
      var v       = pVars[vi] || {};
      var vid     = v.id || "";
      var vMeta   = meta[vid] || {};
      var invId   = (v.inventoryItem && v.inventoryItem.id) ? v.inventoryItem.id : "";

      // custom.good_id (ลอง product meta ก่อน ไม่มีค่อยดู variant meta)
      var rawGoodId = pMeta["custom.good_id"] != null ? pMeta["custom.good_id"]
                    : (vMeta["custom.good_id"] != null ? vMeta["custom.good_id"] : "");
      var goodId = rawGoodId !== "" ? (parseInt(rawGoodId, 10) || "") : "";

      var tagsVal = Array.isArray(p.tags) ? p.tags.join(", ") : (p.tags || "");

      var row = [
        goodId,
        v.sku                || "",
        pid,
        vid,
        invId,
        p.handle             || "",
        p.title              || "",
        p.vendor             || "",
        p.productType        || "",
        tagsVal,
        p.status             || "",
        p.publishedAt        ? "TRUE" : "FALSE",
        v.price        != null ? v.price        : "",
        v.compareAtPrice != null ? v.compareAtPrice : "",
        v.inventoryQuantity != null ? v.inventoryQuantity : "",
        imgSrc,
        pMeta["custom.spapart_or_product"] != null ? pMeta["custom.spapart_or_product"]
          : (vMeta["custom.spapart_or_product"] != null ? vMeta["custom.spapart_or_product"] : "")
      ];

      rows.push(row);
    }
  }

  Logger.log("✅ " + (rows.length - 1) + " variant rows assembled.");
  writeRowsInternal_(rows);
  Logger.log("✅ " + (rows.length - 1) + " rows written to sheet '" + EXPORT_SHEET_NAME + "'");
}

// ============================================================
// PARSE ONE JSONL LINE
// ============================================================
function parseLine_(line, products, variants, images, meta) {
  try {
    var obj      = JSON.parse(line);
    var id       = obj.id || "";
    var parentId = obj.__parentId || "";

    if (id.indexOf("/Product/") !== -1 && !parentId) {
      // บรรทัดสินค้า
      products[id] = obj;

    } else if (id.indexOf("/ProductVariant/") !== -1 && parentId) {
      // บรรทัด variant
      if (!variants[parentId]) variants[parentId] = [];
      variants[parentId].push(obj);

    } else if ((id.indexOf("/Image/") !== -1 || id.indexOf("/MediaImage/") !== -1) && parentId) {
      // บรรทัดรูปภาพ
      if (obj.url) {
        if (!images[parentId]) images[parentId] = [];
        images[parentId].push(obj.url);
      }

    } else if (!id && obj.namespace != null && obj.key != null && parentId) {
      // บรรทัด Metafield
      if (!meta[parentId]) meta[parentId] = {};
      meta[parentId][obj.namespace + "." + obj.key] = obj.value;
    }
  } catch (e) {
    // บรรทัด JSON ไม่สมบูรณ์ ข้ามไป
  }
}

// ============================================================
// WRITE 2D ARRAY TO SHEET (ใช้ Advanced Sheets Service)
// ============================================================
function writeRowsInternal_(rows) {
  if (!rows || rows.length === 0) {
    Logger.log("[WARN] No rows to write.");
    return;
  }

  var ss        = SpreadsheetApp.getActiveSpreadsheet();
  var sheet     = ss.getSheetByName(EXPORT_SHEET_NAME);
  var isNew     = !sheet;

  if (!sheet) {
    sheet = ss.insertSheet(EXPORT_SHEET_NAME);
  } else {
    var lastR = sheet.getLastRow();
    var lastC = sheet.getLastColumn();
    if (lastR > 0 && lastC > 0) {
      sheet.getRange(1, 1, lastR, lastC).clearContent();
    }
  }

  var needRows = rows.length;
  var needCols = rows[0].length;

  if (sheet.getMaxRows() < needRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), needRows - sheet.getMaxRows());
  }
  if (sheet.getMaxColumns() < needCols) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), needCols - sheet.getMaxColumns());
  }

  // เขียนด้วย Advanced Sheets API (เร็วที่สุด ไม่ติด Timeout)
  Sheets.Spreadsheets.Values.update(
    { values: rows },
    ss.getId(),
    EXPORT_SHEET_NAME + "!A1",
    { valueInputOption: "USER_ENTERED" }
  );

  if (isNew) {
    var hr = sheet.getRange(1, 1, 1, needCols);
    hr.setFontWeight("bold");
    hr.setWrap(false);
    sheet.setFrozenRows(1);
    sheet.setRowHeight(1, 25);
  }
}

// ============================================================
// CLEAN HTML IN SHEET (รันแยกหลังจาก Export เสร็จ)
// ============================================================
function cleanHtmlInSheet() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EXPORT_SHEET_NAME);
  if (!sheet) { Logger.log("Sheet not found: " + EXPORT_SHEET_NAME); return; }

  var headers  = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var colIndex = headers.indexOf("Body (HTML)");
  if (colIndex === -1) { Logger.log("Column 'Body (HTML)' not found."); return; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var range  = sheet.getRange(2, colIndex + 1, lastRow - 1, 1);
  var values = range.getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][0]) values[i][0] = stripHtml_(String(values[i][0]));
  }
  range.setValues(values);
  Logger.log("✅ HTML cleaned.");
}

function stripHtml_(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi,  "\n")
    .replace(/<\/p>/gi,       "\n\n")
    .replace(/<\/li>/gi,      "\n")
    .replace(/<li>/gi,        "- ")
    .replace(/<[^>]+>/g,      "")
    .replace(/&nbsp;/g,       " ")
    .replace(/&amp;/g,        "&")
    .replace(/&lt;/g,         "<")
    .replace(/&gt;/g,         ">")
    .replace(/&quot;/g,       '"')
    .replace(/&#39;/g,        "'")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .trim();
}

// ============================================================
// AUTH: GET ACCESS TOKEN (OAuth Client Credentials)
// ============================================================
function getAccessToken_() {
  var props  = PropertiesService.getScriptProperties();
  var token  = props.getProperty(PROP_ACCESS_TOKEN);
  var expiry = Number(props.getProperty(PROP_TOKEN_EXPIRY) || 0);

  if (token && Date.now() < expiry - 300000) return token; // ยังใช้งานได้อีก 5+ นาที

  Logger.log("🔑 Refreshing access token...");
  var res = UrlFetchApp.fetch("https://" + SHOP + "/admin/oauth/access_token", {
    method:      "post",
    contentType: "application/x-www-form-urlencoded",
    payload:     "grant_type=client_credentials" +
                 "&client_id="     + encodeURIComponent(CLIENT_ID) +
                 "&client_secret=" + encodeURIComponent(CLIENT_SECRET),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  var text = res.getContentText();
  var data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("Token response not JSON. HTTP " + code + ": " + text.substring(0, 300));
  }
  if (!data.access_token) {
    throw new Error("Token request failed. HTTP " + code + ": " + text.substring(0, 300));
  }

  var newExpiry = Date.now() + ((Number(data.expires_in) || 3600) * 1000);
  props.setProperty(PROP_ACCESS_TOKEN, data.access_token);
  props.setProperty(PROP_TOKEN_EXPIRY, String(newExpiry));
  Logger.log("✅ Token refreshed.");
  return data.access_token;
}

// ============================================================
// HELPER: CALL SHOPIFY GRAPHQL
// ============================================================
function callGraphQL_(payload) {
  var token = getAccessToken_();
  var res   = UrlFetchApp.fetch("https://" + SHOP + "/admin/api/2025-01/graphql.json", {
    method:      "post",
    contentType: "application/json",
    headers:     { "X-Shopify-Access-Token": token },
    payload:     JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() >= 400) {
    Logger.log("[ERROR] GraphQL HTTP " + res.getResponseCode() + ": " + res.getContentText().substring(0, 300));
    return null;
  }

  return JSON.parse(res.getContentText());
}

// ============================================================
// WEBHOOK: รับข้อมูลจาก Python (doPost)
// ============================================================
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(60000);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ status: "error", message: "Sheet locked: " + err.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    var contents = JSON.parse(e.postData.contents);
    var rows     = contents.rows;
    if (!rows || !rows.length) {
      return ContentService.createTextOutput(
        JSON.stringify({ status: "error", message: "No rows provided" })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    writeRowsInternal_(rows);

    return ContentService.createTextOutput(
      JSON.stringify({ status: "success", count: rows.length - 1 })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ status: "error", message: err.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
