// ============================================================
// CONFIG & CREDENTIALS (Scoped object to prevent clashes with other gs files)
// ============================================================
var STATUS_EXPORT_CONFIG = {
  SHOP: "sevenfive-4062.myshopify.com",
  CLIENT_ID: "696e1e9162c702cc07c2f94a1beacf8a",
  CLIENT_SECRET: "<YOUR_SHOPIFY_CLIENT_SECRET>", // ⚠️ ถูกลบออกเพื่อความปลอดภัยตอน Push กรุณาใส่กลับใน Apps Script
  TARGET_SHEET_NAME: "Active Products",
  WINSPEED_SPREADSHEET_ID: "1-7ap--3aphttTb8M0cXYvVYmRGtZQKRxoUW3nvwuUNA",
  LOG_SHEET_NAME: "Log run script",
  PROP_ACCESS_TOKEN: "ACCESS_TOKEN",
  PROP_TOKEN_EXPIRY: "TOKEN_EXPIRY"
};


// ============================================================
// UI MENU
// ============================================================
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('📦 Product Status Tools')
    .addItem('1. ดึงเฉพาะสินค้าสถานะ Active จาก Shopify', 'getStatusFromProductsExport')
    .addItem('2. ดึงเฉพาะสินค้าสถานะ Inactive จาก Shopify', 'getInactiveStatusFromProductsExport')
    .addSeparator()
    .addItem('⚡ 3. อัปเดตสินค้าบน Shopify เป็น DRAFT (ถ้า status winspeed = I)', 'updateStatusDraftFromWinspeed')
    .addSeparator()
    .addItem('🛑 ปลด Lock ฉุกเฉิน (Release Lock)', 'releaseProductStatusLock')
    .addToUi();
}

// ============================================================
// MAIN FUNCTIONS
// ============================================================

/**
 * 1. ดึงเฉพาะสินค้าสถานะ ACTIVE จาก Shopify ลงหน้า "Active Products" (พร้อม status winspeed)
 */
function getStatusFromProductsExport() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new Error("มีสคริปต์ Product Status กำลังทำงานอยู่แล้ว กรุณารออีกสักครู่แล้วลองใหม่");
  }
  try {
    fetchProductsDirectFromShopify_("status:ACTIVE", STATUS_EXPORT_CONFIG.TARGET_SHEET_NAME || "Active Products");
  } finally {
    lock.releaseLock();
  }
}

/**
 * 2. ดึงเฉพาะสินค้าสถานะ INACTIVE จาก Shopify ลงหน้า "Inactive" (พร้อม status winspeed)
 */
function getInactiveStatusFromProductsExport() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new Error("มีสคริปต์ Product Status กำลังทำงานอยู่แล้ว กรุณารออีกสักครู่แล้วลองใหม่");
  }
  try {
    fetchProductsDirectFromShopify_("status:DRAFT OR status:ARCHIVED", "Inactive");
  } finally {
    lock.releaseLock();
  }
}

/**
 * 3. อัปเดตสินค้าบน Shopify เป็น DRAFT ถ้าคอลัมน์ status winspeed (Col F) = 'I'
 */
function updateStatusDraftFromWinspeed() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new Error("มีสคริปต์ Product Status กำลังทำงานอยู่แล้ว กรุณารออีกสักครู่แล้วลองใหม่");
  }
  try {
    Logger.log("=== เริ่มอัปเดตสถานะสินค้าบน Shopify เป็น DRAFT (ถ้า status winspeed = I) ===");
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getActiveSheet();
    const sheetName = sheet.getName();
    
    // ตรวจสอบหัวตารางเพื่อความปลอดภัย ว่าเป็น Sheet ที่ดึงมาจาก Shopify หรือไม่
    const headers = sheet.getRange(1, 1, 1, 6).getValues()[0];
    if (headers[2] !== "Product GID" || headers[5] !== "status winspeed") {
      const errMsg = `❌ Sheet "${sheetName}" ที่เปิดอยู่ ไม่ใช่ตารางข้อมูลที่รองรับ (ต้องมี Product GID ที่คอลัมน์ C และ status winspeed ที่คอลัมน์ F)`;
      Logger.log(errMsg);
      writeStatusLog_("Update DRAFT", 0, 0, 0, errMsg);
      SpreadsheetApp.getActive().toast(errMsg, "⚠️ ผิด Sheet", 5);
      return;
    }
    
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      const errMsg = "⚠️ ไม่พบข้อมูลใน Sheet " + sheet.getName();
      Logger.log(errMsg);
      writeStatusLog_("Update DRAFT", 0, 0, 0, errMsg);
      return;
    }
    
    // อ่านข้อมูลคอลัมน์ C (Product GID) และ คอลัมน์ F (status winspeed)
    const productGidData = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
    const winspeedData = sheet.getRange(2, 6, lastRow - 1, 1).getValues();
    
    const productGidsToDraft = new Set();
    
    for (let i = 0; i < winspeedData.length; i++) {
      const winspeedStatus = String(winspeedData[i][0] || "").trim().toUpperCase();
      const productGid = String(productGidData[i][0] || "").trim();
      
      if (winspeedStatus === "I" && productGid && productGid.indexOf("gid://shopify/Product/") === 0) {
        productGidsToDraft.add(productGid);
      }
    }
    
    const targetGids = Array.from(productGidsToDraft);
    if (targetGids.length === 0) {
      const msg = "⚠️ ไม่พบรายการสินค้าที่มี status winspeed = 'I'";
      Logger.log(msg);
      writeStatusLog_("Update DRAFT", 0, 0, 0, msg);
      return;
    }
    
    Logger.log(`📌 พบสินค้าที่ต้องปรับสถานะเป็น DRAFT ทั้งหมด ${targetGids.length} รายการ (Unique Product GID)`);
    
    // ใช้ Shopify Bulk Mutation API อัปเดตรวดเดียวใน 3-5 วินาที
    const jsonlLines = targetGids.map(gid => JSON.stringify({
      input: {
        id: gid,
        status: "DRAFT"
      }
    }));
    
    const productUpdateMutation = "mutation productUpdate($input: ProductInput!) { productUpdate(input: $input) { product { id status } userErrors { field message } } }";
    
    const bulkResult = runShopifyBulkMutation_(jsonlLines, productUpdateMutation);
    
    if (bulkResult && bulkResult.success) {
      const successMsg = `⚡ [SUCCESS] อัปเดตสินค้าสถานะเป็น DRAFT บน Shopify สำเร็จ ${targetGids.length} รายการ (เนื่องจาก status winspeed = 'I')`;
      Logger.log(successMsg);
      writeStatusLog_("Update DRAFT", targetGids.length, targetGids.length, 0, successMsg);
    } else {
      const failMsg = `❌ อัปเดตสินค้าเป็น DRAFT ล้มเหลว: ` + (bulkResult ? bulkResult.error : "Unknown error");
      Logger.log(failMsg);
      writeStatusLog_("Update DRAFT", targetGids.length, 0, targetGids.length, failMsg);
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * ปลด Lock ฉุกเฉินเมื่อสคริปต์ค้าง
 */
function releaseProductStatusLock() {
  try {
    const lock = LockService.getScriptLock();
    lock.releaseLock();
    SpreadsheetApp.getActive().toast("✅ ปลด Lock สำเร็จ ลองรันสคริปต์ใหม่ได้แล้ว", "🛑 Release Lock", 5);
    Logger.log("ปลด LockService สำเร็จ");
  } catch (e) {
    SpreadsheetApp.getActive().toast("⚠️ ไม่มี Lock ที่ต้องปลด: " + e.message, "🛑 Release Lock", 5);
  }
}

// ============================================================
// OPTIMIZED WINSPEED STATUS MAP FETCHER (เปิดไฟล์ตรง ไม่ใช้ IMPORTRANGE)
// ============================================================

function fetchWinspeedStatusMap_() {
  const map = new Map();
  try {
    const winspeedSs = SpreadsheetApp.openById(STATUS_EXPORT_CONFIG.WINSPEED_SPREADSHEET_ID);
    const sheet = winspeedSs.getSheetByName("Inactive");
    if (!sheet) {
      Logger.log("⚠️ ไม่พบ Sheet 'Inactive' ใน Winspeed Spreadsheet");
      return map;
    }
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return map;
    
    // อ่านคอลัมน์ B:F (Col B=2, Col F=6, width=5)
    // Index 0 คือ B (Good ID), Index 4 คือ F (status)
    const values = sheet.getRange(2, 2, lastRow - 1, 5).getValues();
    for (let i = 0; i < values.length; i++) {
      const goodId = String(values[i][0] || "").trim();
      const statusVal = String(values[i][4] || "").trim();
      if (goodId && !map.has(goodId)) {
        map.set(goodId, statusVal);
      }
    }
    Logger.log(`📌 ดึงข้อมูล Winspeed Status Map สำเร็จ ${map.size} รายการ (Fast Direct Fetch)`);
  } catch (e) {
    Logger.log("⚠️ ไม่สามารถดึง Winspeed Status Map โดยตรงได้: " + e.message);
  }
  return map;
}

// ============================================================
// CORE LOGIC: SHOPIFY BULK OPERATION QUERY (OPTIMIZED)
// ============================================================

function fetchProductsDirectFromShopify_(statusQuery, targetSheetName) {
  Logger.log(`=== เริ่มดึงสินค้า (${statusQuery}) โดยตรงจาก Shopify API ===`);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. ตรวจสอบว่ามี Bulk Operation อื่นค้างอยู่หรือไม่
  const checkQuery = `{ currentBulkOperation { id status } }`;
  const checkRes = callGraphQL_({ query: checkQuery });
  if (checkRes && checkRes.data && checkRes.data.currentBulkOperation) {
    const currentStatus = checkRes.data.currentBulkOperation.status;
    if (currentStatus === "RUNNING" || currentStatus === "CREATED") {
      Logger.log("⚠️ มี Bulk Operation กำลังทำงานอยู่ก่อนแล้ว รอ 3 วินาที...");
      Utilities.sleep(3000);
    }
  }
  
  // 2. ส่งคำสั่งดึงสินค้าผ่าน Bulk Operation Query
  const bulkQuery = `mutation {
    bulkOperationRunQuery(
      query: """
      {
        products(query: "${statusQuery}") {
          edges {
            node {
              id
              status
              good_id: metafield(namespace: "custom", key: "good_id") {
                value
              }
              variants {
                edges {
                  node {
                    id
                    sku
                  }
                }
              }
            }
          }
        }
      }
      """
    ) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }`;
  
  const runRes = callGraphQL_({ query: bulkQuery });
  if (!runRes || !runRes.data || !runRes.data.bulkOperationRunQuery) {
    Logger.log("❌ ไม่สามารถเริ่ม Bulk Operation Query ได้");
    return;
  }
  
  const userErrors = runRes.data.bulkOperationRunQuery.userErrors || [];
  if (userErrors.length > 0) {
    Logger.log("❌ User Errors: " + JSON.stringify(userErrors));
    return;
  }
  
  Logger.log("🚀 ส่งคำสั่ง Bulk Query สำเร็จ! กำลังรอ Shopify ประมวลผล...");
  
  // 3. Poll รอรับ Download URL
  const pollQuery = `{ currentBulkOperation { id status errorCode objectCount fileSize url } }`;
  let downloadUrl = null;
  let attempts = 0;
  
  while (attempts < 60) {
    Utilities.sleep(1000);
    attempts++;
    const pollRes = callGraphQL_({ query: pollQuery });
    const op = pollRes ? pollRes.data.currentBulkOperation : null;
    
    if (op) {
      if (op.status === "COMPLETED") {
        downloadUrl = op.url;
        break;
      } else if (op.status === "FAILED" || op.status === "CANCELED") {
        Logger.log("❌ Bulk Operation ล้มเหลว: " + op.errorCode);
        return;
      }
    }
  }
  
  if (!downloadUrl) {
    Logger.log("❌ ไม่ได้รับ Download URL ภายในเวลาที่กำหนด");
    return;
  }
  
  // 4. ดาวน์โหลดและจัดโครงสร้างข้อมูล 6 คอลัมน์ (รวม status winspeed)
  const fileRes = UrlFetchApp.fetch(downloadUrl);
  const jsonlContent = fileRes.getContentText();
  const lines = jsonlContent.split("\n");
  
  const productMap = {}; // product_id -> { good_id, status }
  const variantList = [];
  const targetHeaders = ["custom.good_id", "Variant SKU", "Product GID", "Variant GID", "status", "status winspeed"];
  const rows = [targetHeaders];
  
  // 1-Pass JSONL Parse (ประมวลผลลูปเดียวเร็วขึ้น 2 เท่า)
  lines.forEach(line => {
    if (!line.trim()) return;
    try {
      const obj = JSON.parse(line);
      if (!obj.id) return;
      if (obj.id.indexOf("gid://shopify/Product/") === 0) {
        const goodId = obj.good_id ? obj.good_id.value : "";
        productMap[obj.id] = { good_id: goodId, status: obj.status || "" };
      } else if (obj.id.indexOf("gid://shopify/ProductVariant/") === 0) {
        variantList.push(obj);
      }
    } catch (e) {}
  });
  
  // ดึง Winspeed Status Map แบบตรงผ่าน Apps Script (ไม่ใช้ IMPORTRANGE บนแผ่นงาน)
  const winspeedMap = fetchWinspeedStatusMap_();
  
  variantList.forEach(variant => {
    const parent = productMap[variant.__parentId] || {};
    const goodId = parent.good_id || "";
    const winspeedStatus = winspeedMap.size > 0 ? (winspeedMap.get(goodId) || "") : "";
    rows.push([
      goodId,
      variant.sku || "",
      variant.__parentId || "",
      variant.id,
      parent.status || "ACTIVE",
      winspeedStatus
    ]);
  });
  
  // 5. เขียนข้อมูลลง Sheet ปลายทาง (เคลียร์เนื้อหา & ปรับขนาดครั้งเดียว)
  let targetSheet = ss.getSheetByName(targetSheetName);
  if (!targetSheet) {
    targetSheet = ss.insertSheet(targetSheetName);
  } else {
    try {
      // ใช้ Sheets API เคลียร์ข้อมูลจะเร็วกว่าและลดปัญหาติด Timeout รอคำนวณสูตร
      Sheets.Spreadsheets.Values.clear({}, ss.getId(), `'${targetSheetName}'!A:Z`);
    } catch (e) {
      targetSheet.clearContents();
    }
  }
  
  const numRows = rows.length;
  const numCols = targetHeaders.length;
  
  try {
    // เขียนด้วย Sheets API (ขยายขนาด Sheet ให้อัตโนมัติและไม่ติด Timeout)
    Sheets.Spreadsheets.Values.update(
      { majorDimension: "ROWS", values: rows },
      ss.getId(),
      `'${targetSheetName}'!A1`,
      { valueInputOption: "USER_ENTERED" }
    );
  } catch (e) {
    // Fallback สำรองหาก Sheets API ยังไม่เปิด
    Logger.log("⚠️ Fallback to SpreadsheetApp: " + e.message);
    const maxRows = targetSheet.getMaxRows();
    if (maxRows < numRows) targetSheet.insertRowsAfter(maxRows, numRows - maxRows);
    
    const maxCols = targetSheet.getMaxColumns();
    if (maxCols < numCols) targetSheet.insertColumnsAfter(maxCols, numCols - maxCols);
    
    const WRITE_CHUNK_SIZE = 5000;
    for (let i = 0; i < numRows; i += WRITE_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + WRITE_CHUNK_SIZE);
      targetSheet.getRange(i + 1, 1, chunk.length, numCols).setValues(chunk);
    }
  }
  
  // สำรอง: หากดึง Map ตรงไม่สำเร็จ ให้ใส่สูตร IMPORTRANGE เป็น fallback
  if (winspeedMap.size === 0 && numRows > 1) {
    const winspeedFormula = `=IFERROR(VLOOKUP(A2, IMPORTRANGE("${STATUS_EXPORT_CONFIG.WINSPEED_SPREADSHEET_ID}","Inactive!B:F"), 5, FALSE), "")`;
    targetSheet.getRange(2, 6, numRows - 1, 1).setFormula(winspeedFormula);
    Logger.log(`📌 ดึง Map ตรงไม่สำเร็จ จึงใส่สูตร IMPORTRANGE สำรอง (${numRows - 1} แถว)`);
  }
  
  targetSheet.getRange(1, 1, 1, numCols).setFontWeight("bold");
  targetSheet.setFrozenRows(1);
  
  const successMsg = `✅ ดึงข้อมูลสินค้าสถานะ ${statusQuery} จาก Shopify สำเร็จ ${rows.length - 1} แถว (Optimized) ลงใน Sheet "${targetSheetName}"`;
  Logger.log(successMsg);
  writeStatusLog_(targetSheetName, rows.length - 1, rows.length - 1, 0, successMsg);
}

// ============================================================
// SHOPIFY BULK MUTATION RUNNER (stagedUploadsCreate + bulkOperationRunMutation)
// ============================================================

function runShopifyBulkMutation_(jsonlLines, mutationQueryString) {
  const jsonlData = jsonlLines.join("\n");
  
  const stageMutation = `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }`;

  const stageVars = {
    input: [{
      resource: "BULK_MUTATION_VARIABLES",
      filename: "bulk_status_update.jsonl",
      mimeType: "text/jsonl",
      httpMethod: "POST"
    }]
  };

  const stageRes = callGraphQL_({ query: stageMutation, variables: stageVars });
  if (!stageRes || !stageRes.data || !stageRes.data.stagedUploadsCreate) {
    return { success: false, error: "stagedUploadsCreate failed" };
  }

  const target = stageRes.data.stagedUploadsCreate.stagedTargets[0];
  const uploadUrl = target.url;
  const keyParam = target.parameters.find(p => p.name === "key");
  if (!keyParam) return { success: false, error: "Key param missing in stagedUploadsCreate" };
  const stagedPath = keyParam.value;

  // Upload JSONL Payload to Shopify S3 Staging
  const payloadParts = {};
  target.parameters.forEach(p => { payloadParts[p.name] = p.value; });
  payloadParts["file"] = Utilities.newBlob(jsonlData, "text/jsonl", "bulk_status_update.jsonl");

  const uploadOptions = { method: "post", payload: payloadParts, muteHttpExceptions: true };
  const uploadRes = UrlFetchApp.fetch(uploadUrl, uploadOptions);
  if (uploadRes.getResponseCode() >= 400) {
    return { success: false, error: "Upload payload to S3 failed: " + uploadRes.getContentText() };
  }

  // Trigger Bulk Mutation Operation
  const runMutation = `mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
    bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }`;

  const runVars = {
    mutation: mutationQueryString,
    stagedUploadPath: stagedPath
  };

  const runRes = callGraphQL_({ query: runMutation, variables: runVars });
  if (!runRes || !runRes.data || !runRes.data.bulkOperationRunMutation) {
    return { success: false, error: "bulkOperationRunMutation failed" };
  }

  const userErrors = runRes.data.bulkOperationRunMutation.userErrors || [];
  if (userErrors.length > 0) {
    return { success: false, error: JSON.stringify(userErrors) };
  }

  const opId = runRes.data.bulkOperationRunMutation.bulkOperation.id;
  Logger.log("🚀 Bulk Mutation Started: " + opId);

  // Poll for completion
  const pollQuery = `{ currentBulkOperation { id status errorCode objectCount fileSize } }`;
  let attempts = 0;
  while (attempts < 60) {
    Utilities.sleep(2000);
    attempts++;
    const pollRes = callGraphQL_({ query: pollQuery });
    const op = pollRes ? pollRes.data.currentBulkOperation : null;
    if (op) {
      Logger.log(`  [Poll ${attempts}] Status: ${op.status} | Processed: ${op.objectCount || 0}`);
      if (op.status === "COMPLETED") return { success: true, count: op.objectCount };
      if (op.status === "FAILED" || op.status === "CANCELED") return { success: false, error: op.errorCode };
    }
  }
  return { success: false, error: "Timeout waiting for bulk mutation completion" };
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function writeStatusLog_(targetSheetName, totalItems, successCount, failedCount, statusMsg) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let logSheet = ss.getSheetByName(STATUS_EXPORT_CONFIG.LOG_SHEET_NAME);
    if (!logSheet) {
      logSheet = ss.insertSheet(STATUS_EXPORT_CONFIG.LOG_SHEET_NAME);
      const headers = ["Timestamp", "Target Sheet", "Total Items", "Success", "Failed / Skipped", "Status Message"];
      logSheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
      logSheet.setFrozenRows(1);
    }
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT+7", "yyyy-MM-dd HH:mm:ss");
    logSheet.appendRow([timestamp, targetSheetName, totalItems, successCount, failedCount, statusMsg || "Completed"]);
  } catch (e) {}
}

function getAccessToken_() {
  const props  = PropertiesService.getScriptProperties();
  const token  = props.getProperty(STATUS_EXPORT_CONFIG.PROP_ACCESS_TOKEN);
  const expiry = Number(props.getProperty(STATUS_EXPORT_CONFIG.PROP_TOKEN_EXPIRY) || 0);

  if (token && Date.now() < expiry - 300000) return token;

  const res = UrlFetchApp.fetch("https://" + STATUS_EXPORT_CONFIG.SHOP + "/admin/oauth/access_token", {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: "grant_type=client_credentials&client_id=" + encodeURIComponent(STATUS_EXPORT_CONFIG.CLIENT_ID) + "&client_secret=" + encodeURIComponent(STATUS_EXPORT_CONFIG.CLIENT_SECRET),
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
  props.setProperty(STATUS_EXPORT_CONFIG.PROP_ACCESS_TOKEN, data.access_token);
  props.setProperty(STATUS_EXPORT_CONFIG.PROP_TOKEN_EXPIRY, String(newExpiry));
  return data.access_token;
}

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
    
    const res = UrlFetchApp.fetch("https://" + STATUS_EXPORT_CONFIG.SHOP + "/admin/api/2025-01/graphql.json", options);
    const code = res.getResponseCode();
    
    if (code === 401) {
      PropertiesService.getScriptProperties().deleteProperty(STATUS_EXPORT_CONFIG.PROP_ACCESS_TOKEN);
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
