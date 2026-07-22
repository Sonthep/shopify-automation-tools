// ============================================================
// CONFIG & CREDENTIALS (Scoped object to prevent clashes with other gs files)
// ============================================================
var STATUS_EXPORT_CONFIG = {
  SHOP: "sevenfive-4062.myshopify.com",
  CLIENT_ID: "xxxxxxxxxxxxxxxxxxx",
  CLIENT_SECRET: "xxxxxxxxxxxxxxxxxxx",
  TARGET_SHEET_NAME: "Active Products",
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
    .addToUi();
}

// ============================================================
// MAIN FUNCTIONS
// ============================================================

/**
 * ดึงเฉพาะสินค้าสถานะ ACTIVE จาก Shopify ลงหน้า "Active Products" (เร็วที่สุด 3-5 วินาที)
 */
function getStatusFromProductsExport() {
  fetchProductsDirectFromShopify_("status:ACTIVE", STATUS_EXPORT_CONFIG.TARGET_SHEET_NAME || "Active Products");
}

/**
 * ดึงเฉพาะสินค้าสถานะ INACTIVE จาก Shopify ลงหน้า "Inactive" (เร็วที่สุด 3-5 วินาที)
 */
function getInactiveStatusFromProductsExport() {
  fetchProductsDirectFromShopify_("status:DRAFT OR status:ARCHIVED", "Inactive");
}

// ============================================================
// CORE LOGIC: SHOPIFY BULK OPERATION QUERY (3-5 วินาที)
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
  
  // 4. ดาวน์โหลดและจัดโครงสร้างข้อมูล 5 คอลัมน์ตามที่ระบุ
  // custom.good_id, Variant SKU, Product GID, Variant GID, status
  const fileRes = UrlFetchApp.fetch(downloadUrl);
  const jsonlContent = fileRes.getContentText();
  const lines = jsonlContent.split("\n");
  
  const productMap = {}; // product_id -> { good_id, status }
  const targetHeaders = ["custom.good_id", "Variant SKU", "Product GID", "Variant GID", "status"];
  const rows = [targetHeaders];
  
  // Parse Product (แม่)
  lines.forEach(line => {
    if (!line.trim()) return;
    try {
      const obj = JSON.parse(line);
      if (obj.id && obj.id.indexOf("gid://shopify/Product/") === 0) {
        const goodId = obj.good_id ? obj.good_id.value : "";
        productMap[obj.id] = { good_id: goodId, status: obj.status || "" };
      }
    } catch (e) {}
  });
  
  // Parse Variant (ลูก)
  lines.forEach(line => {
    if (!line.trim()) return;
    try {
      const obj = JSON.parse(line);
      if (obj.id && obj.id.indexOf("gid://shopify/ProductVariant/") === 0 && obj.__parentId) {
        const parent = productMap[obj.__parentId] || {};
        rows.push([
          parent.good_id || "",
          obj.sku || "",
          obj.__parentId,
          obj.id,
          parent.status || "ACTIVE"
        ]);
      }
    } catch (e) {}
  });
  
  // 5. เขียนข้อมูลลง Sheet ปลายทาง (แบ่ง Chunk ละ 5,000 แถว)
  let targetSheet = ss.getSheetByName(targetSheetName);
  if (!targetSheet) {
    targetSheet = ss.insertSheet(targetSheetName);
  } else {
    targetSheet.clear();
  }
  
  const numRows = rows.length;
  const numCols = targetHeaders.length;
  
  const currentRows = targetSheet.getMaxRows();
  const currentCols = targetSheet.getMaxColumns();
  
  if (currentCols < numCols) targetSheet.insertColumnsAfter(currentCols, numCols - currentCols);
  else if (currentCols > numCols) targetSheet.deleteColumns(numCols + 1, currentCols - numCols);
  
  if (currentRows < numRows) targetSheet.insertRowsAfter(currentRows, numRows - currentRows);
  else if (currentRows > numRows) targetSheet.deleteRows(numRows + 1, currentRows - numRows);
  
  const WRITE_CHUNK_SIZE = 5000;
  for (let i = 0; i < numRows; i += WRITE_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + WRITE_CHUNK_SIZE);
    targetSheet.getRange(i + 1, 1, chunk.length, numCols).setValues(chunk);
  }
  
  targetSheet.getRange(1, 1, 1, numCols).setFontWeight("bold");
  targetSheet.setFrozenRows(1);
  
  const successMsg = `✅ ดึงข้อมูลสินค้าสถานะ ${statusQuery} จาก Shopify สำเร็จ ${rows.length - 1} แถว ลงใน Sheet "${targetSheetName}"`;
  Logger.log(successMsg);
  writeStatusLog_(targetSheetName, rows.length - 1, rows.length - 1, 0, successMsg);
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
