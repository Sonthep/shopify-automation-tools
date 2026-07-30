

// ============================================================
// CONFIG & CREDENTIALS (Scoped object to prevent clashes with other gs files)
// ============================================================
var SHOPIFY_INV_CONFIG = {
  SHOP: "sevenfive-4062.myshopify.com",
  CLIENT_ID: "696e1e9162c702cc07c2f94a1beacf8a",
  CLIENT_SECRET: "xxxxxxxxxxxxxxxxxxx",
  TARGET_SHEET_NAME: "Inventory",
  LOG_SHEET_NAME: "Log run script",
  BATCH_SIZE: 25,
  PROP_ACCESS_TOKEN: "ACCESS_TOKEN",
  PROP_TOKEN_EXPIRY: "TOKEN_EXPIRY"
};

// ============================================================
// UI MENU
// ============================================================
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('📦 Inventory Update Tools')
    .addItem('🚀 1. อัปเดตสต็อกแบบเร็วที่สุด (Bulk Mutation - รวดเดียวเสร็จใน 5 วินาที)', 'updateInventoryBulkMutation')
    .addSeparator()
    .addItem('2. อัปเดตสต็อกแบบ Direct Batch (25 รายการ/Request)', 'updateInventoryDirectBatch')
    .addToUi();
}

// ============================================================
// ULTRA-FAST BULK MUTATION METHOD (Shopify Bulk Operation API)
// ============================================================

/**
 * อัปเดตสต็อกสินค้าทั้งหมดขึ้น Shopify ด้วยวิธี Bulk Operation API (ความเร็วสูงสุด)
 * แปลงข้อมูลใน Sheet 'Inventory' เป็น JSONL และส่งให้ Shopify ประมวลผลแบบ Parallel บน Cloud
 * ทำงานเสร็จใน Apps Script ภายในไม่ถึง 5 วินาที!
 */
function updateInventoryBulkMutation() {
  Logger.log("=== เริ่มต้นอัปเดตสต็อกสินค้าแบบ Bulk Operation API (ความเร็วสูงสุด) ===");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME);
  
  if (!sheet) {
    const errMsg = `❌ ไม่พบ Sheet ชื่อ "${SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME}"`;
    Logger.log(errMsg);
    writeInventoryRunLog_(SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME, 0, 0, 0, errMsg);
    return;
  }
  
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  
  if (lastRow < 2) {
    const warnMsg = `⚠️ ไม่พบข้อมูลใน Sheet "${SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME}"`;
    Logger.log(warnMsg);
    writeInventoryRunLog_(SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME, 0, 0, 0, warnMsg);
    return;
  }
  
  // 1. ดึง Location ID หลักของร้านอัตโนมัติจาก Shopify
  const locationId = getPrimaryLocationId_();
  if (!locationId) {
    const locErr = "❌ ไม่สามารถดึง Location ID หลักของร้านค้าได้";
    Logger.log(locErr);
    writeInventoryRunLog_(SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME, 0, 0, 0, locErr);
    return;
  }
  
  Logger.log(`✅ ใช้ Location ID หลัก: ${locationId}`);
  
  // 2. อ่านข้อมูลจาก Sheet "Inventory"
  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = data[0].map(h => String(h).trim());
  const rows = data.slice(1);
  
  const qtyIdx = findColIndex_(headers, ["Inventory quantity", "InventoryQuantity", "quantity", "จำนวนสต็อก", "จำนวน"]);
  const invItemIdx = findColIndex_(headers, ["Inventory Item ID", "InventoryItemID", "inventory_item_id"]);
  
  // ตำแหน่งมาตรฐาน: Col C = Inventory quantity (2), Col D = Inventory Item ID (3)
  const colQty = qtyIdx !== -1 ? qtyIdx : 2;
  const colInvItem = invItemIdx !== -1 ? invItemIdx : 3;
  
  const jsonlLines = [];
  let skipped = 0;
  
  rows.forEach(row => {
    const invItemId = String(row[colInvItem] || "").trim();
    const qtyRaw = row[colQty];
    const qtyNum = parseInt(qtyRaw, 10);
    
    if (!invItemId || invItemId.indexOf("gid://shopify/InventoryItem/") === -1 || isNaN(qtyNum)) {
      skipped++;
      return;
    }
    
    // สร้างโครงสร้าง Input สำหรับ inventorySetQuantities
    const inputObj = {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities: [{
          inventoryItemId: invItemId,
          locationId: locationId,
          quantity: qtyNum
        }]
      }
    };
    
    jsonlLines.push(JSON.stringify(inputObj));
  });
  
  const totalItems = jsonlLines.length;
  if (totalItems === 0) {
    const emptyMsg = "⚠️ ไม่พบรายการสต็อกที่สมบูรณ์ (ต้องมี Inventory Item ID และจำนวนสต็อกเป็นตัวเลข)";
    Logger.log(emptyMsg);
    writeInventoryRunLog_(SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME, rows.length, 0, rows.length, emptyMsg);
    return;
  }
  
  Logger.log(`📊 รวมข้อมูลสต็อก JSONL พร้อมส่ง: ${totalItems} รายการ (ข้าม ${skipped} รายการที่ไม่สมบูรณ์)`);
  
  // 3. ขอ Staged Upload Target จาก Shopify
  const stageMutation = `mutation {
    stagedUploadsCreate(input: [{
      resource: BULK_MUTATION_VARIABLES,
      filename: "inventory_bulk.jsonl",
      mimeType: "text/jsonl",
      httpMethod: PUT
    }]) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }`;
  
  const stageRes = callGraphQL_({ query: stageMutation });
  if (!stageRes || !stageRes.data || !stageRes.data.stagedUploadsCreate) {
    const errStage = "❌ สร้าง Staged Upload ล้มเหลว";
    Logger.log(errStage);
    writeInventoryRunLog_(SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME, totalItems, 0, totalItems, errStage);
    return;
  }
  
  const target = stageRes.data.stagedUploadsCreate.stagedTargets[0];
  const uploadUrl = target.url;
  const resourceUrl = target.resourceUrl;
  
  // 4. Upload JSONL Payload ขึ้น Shopify Staged Target
  const jsonlContent = jsonlLines.join("\n") + "\n";
  Logger.log("📤 กำลังอัปโหลดไฟล์ JSONL สต็อก ขนาด " + Math.round(jsonlContent.length / 1024) + " KB ขึ้น Shopify...");
  
  const putOptions = {
    method: "put",
    contentType: "text/jsonl",
    payload: jsonlContent,
    muteHttpExceptions: true
  };
  
  const putRes = UrlFetchApp.fetch(uploadUrl, putOptions);
  if (putRes.getResponseCode() >= 400) {
    const errPut = `❌ Upload JSONL ล้มเหลว (HTTP ${putRes.getResponseCode()})`;
    Logger.log(errPut);
    writeInventoryRunLog_(SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME, totalItems, 0, totalItems, errPut);
    return;
  }
  
  Logger.log("✅ Upload JSONL สำเร็จ! กำลังสั่ง Shopify เริ่มอัปเดตสต็อกในพื้นหลัง...");
  
  // 5. สั่ง Shopify รัน bulkOperationRunMutation สำหรับ inventorySetQuantities
  const runMutation = `mutation bulkRun($stagedUploadPath: String!) {
    bulkOperationRunMutation(
      mutation: "mutation invSet($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { field message } } }",
      stagedUploadPath: $stagedUploadPath
    ) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }`;
  
  const runRes = callGraphQL_({ query: runMutation, variables: { stagedUploadPath: resourceUrl } });
  if (runRes && runRes.data && runRes.data.bulkOperationRunMutation) {
    const bulkOp = runRes.data.bulkOperationRunMutation.bulkOperation;
    const userErrors = runRes.data.bulkOperationRunMutation.userErrors || [];
    
    if (userErrors.length > 0) {
      const errRun = "❌ Bulk Operation สต็อกเกิดข้อผิดพลาด: " + JSON.stringify(userErrors);
      Logger.log(errRun);
      writeInventoryRunLog_(SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME, totalItems, 0, totalItems, errRun);
    } else if (bulkOp) {
      const successMsg = `🚀 สั่งคำสั่ง Bulk Operation อัปเดตสต็อกสำเร็จ! (ID: ${bulkOp.id}, Status: ${bulkOp.status}) ทั้งหมด ${totalItems} รายการกำลังอัปเดตบน Shopify Cloud`;
      Logger.log(successMsg);
      writeInventoryRunLog_(SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME, rows.length, totalItems, skipped, successMsg);
    }
  } else {
    const errRunFail = "❌ ไม่สามารถเริ่ม Bulk Operation สำหรับสต็อกได้";
    Logger.log(errRunFail);
    writeInventoryRunLog_(SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME, totalItems, 0, totalItems, errRunFail);
  }
}

// ============================================================
// DIRECT BATCH METHOD (GraphQL Alias Batching)
// ============================================================

/**
 * อัปเดตสต็อกสินค้าแบบ Direct Batch (25 รายการ/Request)
 */
function updateInventoryDirectBatch() {
  Logger.log("=== เริ่มต้นอัปเดตสต็อกสินค้าแบบ Direct Batch ===");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME);
  
  if (!sheet) {
    const errMsg = `❌ ไม่พบ Sheet ชื่อ "${SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME}"`;
    Logger.log(errMsg);
    writeInventoryRunLog_(SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME, 0, 0, 0, errMsg);
    return;
  }
  
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  
  if (lastRow < 2) {
    const warnMsg = `⚠️ ไม่พบข้อมูลใน Sheet "${SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME}"`;
    Logger.log(warnMsg);
    writeInventoryRunLog_(SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME, 0, 0, 0, warnMsg);
    return;
  }
  
  const locationId = getPrimaryLocationId_();
  if (!locationId) {
    const locErr = "❌ ไม่สามารถดึง Location ID หลักของร้านค้าได้";
    Logger.log(locErr);
    writeInventoryRunLog_(SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME, 0, 0, 0, locErr);
    return;
  }
  
  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = data[0].map(h => String(h).trim());
  const rows = data.slice(1);
  
  const qtyIdx = findColIndex_(headers, ["Inventory quantity", "InventoryQuantity", "quantity", "จำนวนสต็อก"]);
  const invItemIdx = findColIndex_(headers, ["Inventory Item ID", "InventoryItemID", "inventory_item_id"]);
  
  const colQty = qtyIdx !== -1 ? qtyIdx : 2;
  const colInvItem = invItemIdx !== -1 ? invItemIdx : 3;
  
  const pendingItems = [];
  let skipped = 0;
  
  rows.forEach(row => {
    const invItemId = String(row[colInvItem] || "").trim();
    const qtyNum = parseInt(row[colQty], 10);
    
    if (!invItemId || invItemId.indexOf("gid://shopify/InventoryItem/") === -1 || isNaN(qtyNum)) {
      skipped++;
      return;
    }
    
    pendingItems.push({
      inventoryItemId: invItemId,
      locationId: locationId,
      quantity: qtyNum
    });
  });
  
  Logger.log(`📊 พบรายการที่จะอัปเดตสต็อก: ${pendingItems.length} รายการ (ข้าม ${skipped} รายการที่ไม่สมบูรณ์)`);
  
  let totalSuccess = 0;
  let totalFailed = 0;
  const batchSize = SHOPIFY_INV_CONFIG.BATCH_SIZE;
  
  for (let i = 0; i < pendingItems.length; i += batchSize) {
    const chunk = pendingItems.slice(i, i + batchSize);
    const batchRes = sendBatchInventoryUpdates_(chunk);
    totalSuccess += batchRes.success;
    totalFailed += batchRes.failed;
    
    Logger.log(`  ประมวลผลแล้ว ${Math.min(i + batchSize, pendingItems.length)}/${pendingItems.length} (สำเร็จ: ${totalSuccess}, ล้มเหลว: ${totalFailed})`);
    
    if (i + batchSize < pendingItems.length) {
      Utilities.sleep(300);
    }
  }
  
  totalFailed += skipped;
  const statusMsg = `อัปเดตสต็อกสำเร็จ ${totalSuccess}/${pendingItems.length} รายการ (ข้าม/ล้มเหลว ${totalFailed} รายการ)`;
  Logger.log(statusMsg);
  
  writeInventoryRunLog_(SHOPIFY_INV_CONFIG.TARGET_SHEET_NAME, rows.length, totalSuccess, totalFailed, statusMsg);
}

// ============================================================
// HELPER: Send Batch Inventory Updates
// ============================================================

function sendBatchInventoryUpdates_(items) {
  if (!items || items.length === 0) return { success: 0, failed: 0 };
  
  const mutationLines = items.map((item, idx) => {
    return `i${idx}: inventorySetQuantities(input: { name: "available", reason: "correction", ignoreCompareQuantity: true, quantities: [{ inventoryItemId: "${item.inventoryItemId}", locationId: "${item.locationId}", quantity: ${item.quantity} }] }) { inventoryAdjustmentGroup { id } userErrors { field message } }`;
  });
  
  const fullQuery = `mutation {\n${mutationLines.join("\n")}\n}`;
  const payload = { query: fullQuery };
  const res = callGraphQL_(payload);
  
  let success = 0;
  let failed = 0;
  
  if (res && res.data) {
    Object.keys(res.data).forEach(aliasKey => {
      const resultObj = res.data[aliasKey];
      if (resultObj && resultObj.userErrors && resultObj.userErrors.length > 0) {
        failed++;
        Logger.log(`  [WARN] ${aliasKey} userErrors: ` + JSON.stringify(resultObj.userErrors));
      } else if (resultObj) {
        success++;
      } else {
        failed++;
      }
    });
  } else {
    failed += items.length;
  }
  
  return { success, failed };
}

// ============================================================
// HELPER: FETCH PRIMARY LOCATION ID
// ============================================================

/**
 * ดึง Location ID หลักของร้านค้าจาก Shopify อัตโนมัติ
 */
function getPrimaryLocationId_() {
  const query = `{ locations(first: 1) { edges { node { id } } } }`;
  const res = callGraphQL_({ query: query });
  
  if (res && res.data && res.data.locations && res.data.locations.edges.length > 0) {
    return res.data.locations.edges[0].node.id;
  }
  return null;
}

// ============================================================
// HELPER: WRITE LOG TO SHEET
// ============================================================

function writeInventoryRunLog_(sheetName, totalItems, successCount, failedCount, statusMsg) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let logSheet = ss.getSheetByName(SHOPIFY_INV_CONFIG.LOG_SHEET_NAME);
    
    if (!logSheet) {
      logSheet = ss.insertSheet(SHOPIFY_INV_CONFIG.LOG_SHEET_NAME);
      const headers = ["Timestamp", "Target Sheet", "Total Items", "Success", "Failed / Skipped", "Status Message"];
      logSheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
      logSheet.setFrozenRows(1);
    }
    
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT+7", "yyyy-MM-dd HH:mm:ss");
    logSheet.appendRow([timestamp, sheetName, totalItems, successCount, failedCount, statusMsg || "Completed"]);
  } catch (e) {
    Logger.log("⚠️ เกิดข้อผิดพลาดในการบันทึก Log: " + e);
  }
}

// ============================================================
// HELPER: FLEXIBLE COLUMN FINDER
// ============================================================
function findColIndex_(headers, candidates) {
  for (let i = 0; i < headers.length; i++) {
    for (let j = 0; j < candidates.length; j++) {
      if (headers[i].toLowerCase() === candidates[j].toLowerCase()) return i;
    }
  }
  return -1;
}

// ============================================================
// HELPER: AUTH (Auto Refresh Access Token)
// ============================================================
function getAccessToken_() {
  const props  = PropertiesService.getScriptProperties();
  const token  = props.getProperty(SHOPIFY_INV_CONFIG.PROP_ACCESS_TOKEN);
  const expiry = Number(props.getProperty(SHOPIFY_INV_CONFIG.PROP_TOKEN_EXPIRY) || 0);

  if (token && Date.now() < expiry - 300000) return token;

  const res = UrlFetchApp.fetch("https://" + SHOPIFY_INV_CONFIG.SHOP + "/admin/oauth/access_token", {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: "grant_type=client_credentials&client_id=" + encodeURIComponent(SHOPIFY_INV_CONFIG.CLIENT_ID) + "&client_secret=" + encodeURIComponent(SHOPIFY_INV_CONFIG.CLIENT_SECRET),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error("Token response is not valid JSON. HTTP " + code + ": " + text);
  }
  if (!data.access_token) throw new Error("Token acquisition failed. HTTP " + code + ": " + text);

  const newExpiry = Date.now() + ((Number(data.expires_in) || 3600) * 1000);
  props.setProperty(SHOPIFY_INV_CONFIG.PROP_ACCESS_TOKEN, data.access_token);
  props.setProperty(SHOPIFY_INV_CONFIG.PROP_TOKEN_EXPIRY, String(newExpiry));
  return data.access_token;
}

// ============================================================
// HELPER: GRAPHQL CALLER WITH AUTO-RETRY ON THROTTLE / 401
// ============================================================
function callGraphQL_(payload) {
  let maxRetries = 5;
  let waitMs = 2000;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const accessToken = getAccessToken_();
    const options = {
      method: "post",
      contentType: "application/json",
      headers: { "X-Shopify-Access-Token": accessToken },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
    
    const res = UrlFetchApp.fetch("https://" + SHOPIFY_INV_CONFIG.SHOP + "/admin/api/2025-01/graphql.json", options);
    const code = res.getResponseCode();
    
    if (code === 401) {
      PropertiesService.getScriptProperties().deleteProperty(SHOPIFY_INV_CONFIG.PROP_ACCESS_TOKEN);
      Utilities.sleep(1000);
      continue;
    }
    
    if (code >= 400) {
      Logger.log("[ERROR] GraphQL HTTP " + code + ": " + res.getContentText().substring(0, 300));
      return null;
    }
    
    let jsonBody;
    try { jsonBody = JSON.parse(res.getContentText()); } catch (e) { return null; }
    
    const errors = jsonBody.errors || [];
    if (errors.length > 0) {
      const isThrottled = errors.every(err => (err.extensions && err.extensions.code === "THROTTLED"));
      if (isThrottled) {
        Utilities.sleep(waitMs);
        waitMs = Math.min(waitMs * 2, 30000);
        continue;
      }
      Logger.log("[ERROR] GraphQL Errors: " + JSON.stringify(errors));
      return null;
    }
    return jsonBody;
  }
  return null;
}
