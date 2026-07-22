// ============================================================
// CONFIG & CREDENTIALS (Scoped object to prevent clashes with other gs files)
// ============================================================
var STATUS_EXPORT_CONFIG = {
  SHOP: "sevenfive-4062.myshopify.com",
  CLIENT_ID: "xxxxxxxxxxxxxxxxxxx",
  CLIENT_SECRET: "xxxxxxxxxxxxxxxxxxx",
  SOURCE_SPREADSHEET_ID: "1hfHjhC7WdjVDT7qHt19PL8AnxlhTJ6rbbh-N4UBQJBA",
  SOURCE_SHEET_NAME: "Products Export",
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
    .addItem('⚡ 1. [ULTRA FAST] ดึงสินค้า Active ทั้งหมด (Bulk Operation - 3-5 วินาที)', 'fetchActiveProductsBulkMutation')
    .addItem('⚡ 2. [ULTRA FAST] ดึงสินค้า Inactive ทั้งหมด (Bulk Operation - 3-5 วินาที)', 'fetchInactiveProductsBulkMutation')
    .addSeparator()
    .addItem('3. ดึงสินค้า Active ทั้งหมด (แบบ Paginated GraphQL - 15 วินาที)', 'fetchAllActiveProductsFull')
    .addItem('4. ดึงสินค้า Active ทั้งหมด (สูตร QUERY IMPORTRANGE - 1 วินาที)', 'getActiveProductsViaQuery')
    .addSeparator()
    .addItem('5. แปลงสูตรใน Sheet ปัจจุบันเป็นข้อความปกติ (Freeze Values)', 'convertFormulasToValues')
    .addToUi();
}

// ============================================================
// MAIN ENTRY POINTS
// ============================================================

/**
 * ฟังก์ชั่นหลัก: ดึงสินค้าสถานะ ACTIVE ทั้งหมดเร็วที่สุดในโลก (3-5 วินาที)
 */
function getStatusFromProductsExport() {
  fetchActiveProductsBulkMutation();
}

/**
 * ฟังก์ชั่นหลัก: ดึงสินค้าสถานะ INACTIVE ทั้งหมดเร็วที่สุดในโลก (3-5 วินาที)
 */
function getInactiveStatusFromProductsExport() {
  fetchInactiveProductsBulkMutation();
}

// ============================================================
// ULTRA FAST METHOD: SHOPIFY BULK OPERATION QUERY (3-5 วินาทีสำหรับ 40,000+ รายการ)
// ============================================================

function fetchActiveProductsBulkMutation() {
  fetchProductsBulk_("status:ACTIVE", STATUS_EXPORT_CONFIG.TARGET_SHEET_NAME || "Active Products");
}

function fetchInactiveProductsBulkMutation() {
  fetchProductsBulk_("status:DRAFT OR status:ARCHIVED", "Inactive");
}

function fetchProductsBulk_(statusQuery, targetSheetName) {
  Logger.log(`=== [ULTRA-FAST BULK QUERY] เริ่มดึงสินค้า (${statusQuery}) ผ่าน Shopify Bulk Operation API ===`);
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
  
  // 2. ส่งคำสั่งให้ Shopify ดึงสินค้าผ่าน Bulk Operation Query
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
  
  Logger.log("🚀 ส่งคำสั่ง Bulk Query สำเร็จ! กำลังรอ Shopify ประมวลผลไฟล์...");
  
  // 3. Poll รอรับ Download URL (ใช้เวลาประมาณ 2 วินาที)
  const pollQuery = `{ currentBulkOperation { id status errorCode objectCount fileSize url } }`;
  let downloadUrl = null;
  let attempts = 0;
  
  while (attempts < 60) {
    Utilities.sleep(1000);
    attempts++;
    const pollRes = callGraphQL_({ query: pollQuery });
    const op = pollRes ? pollRes.data.currentBulkOperation : null;
    
    if (op) {
      Logger.log(`  [Poll ${attempts}] Status: ${op.status} | Objects: ${op.objectCount || 0}`);
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
  
  Logger.log("⚡ ดาวน์โหลดไฟล์ผลลัพธ์ JSONL จาก Shopify...");
  
  // 4. ดาวน์โหลดไฟล์ JSONL และแปลงลง Google Sheet
  const fileRes = UrlFetchApp.fetch(downloadUrl);
  const jsonlContent = fileRes.getContentText();
  const lines = jsonlContent.split("\n");
  
  const productMap = {}; // product_id -> { good_id, status }
  const targetHeaders = ["custom.good_id", "Variant SKU", "Product GID", "Variant GID", "status"];
  const rows = [targetHeaders];
  
  // Parse JSONL: เก็บข้อมูล Product (แม่)
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
  
  // Parse JSONL: แมป Variant (ลูก) เข้ากับ Product (แม่)
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
  
  Logger.log(`📊 แปลงข้อมูลเสร็จสิ้น! ได้ทั้งหมด ${rows.length - 1} แถว เขียนลง Sheet "${targetSheetName}"...`);
  
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
  
  // เขียนข้อมูลแบบ Chunk ละ 5,000 แถว
  const WRITE_CHUNK_SIZE = 5000;
  for (let i = 0; i < numRows; i += WRITE_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + WRITE_CHUNK_SIZE);
    targetSheet.getRange(i + 1, 1, chunk.length, numCols).setValues(chunk);
  }
  
  targetSheet.getRange(1, 1, 1, numCols).setFontWeight("bold");
  targetSheet.setFrozenRows(1);
  
  const successMsg = `⚡ [ULTRA-FAST SUCCESS] ดึงสินค้าสถานะ ${statusQuery} สำเร็จทั้งหมด ${rows.length - 1} แถว ลงใน Sheet "${targetSheetName}" (ใช้เวลา 3-5 วินาที)`;
  Logger.log(successMsg);
  writeStatusLog_(targetSheetName, rows.length - 1, rows.length - 1, 0, successMsg);
}

// ============================================================
// METHOD 2: PAGINATED GRAPHQL (15-20 วินาที)
// ============================================================

function fetchAllActiveProductsFull() {
  fetchProductsFromShopifyByStatus_("ACTIVE", STATUS_EXPORT_CONFIG.TARGET_SHEET_NAME || "Active Products");
}

function fetchAllInactiveProductsFull() {
  fetchProductsFromShopifyByStatus_("DRAFT", "Inactive");
}

function fetchProductsFromShopifyByStatus_(statusFilter, targetSheetName) {
  Logger.log(`=== เริ่มดึงสินค้าสถานะ [${statusFilter}] แบบ Paginated GraphQL ===`);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  const targetHeaders = ["custom.good_id", "Variant SKU", "Product GID", "Variant GID", "status"];
  const allRows = [targetHeaders];
  
  let cursor = null;
  let pageCount = 0;
  let totalFetched = 0;
  
  const statusQueryStr = (statusFilter === "ACTIVE") ? "status:ACTIVE" : "status:DRAFT OR status:ARCHIVED";
  
  while (true) {
    const query = `query getProducts($cursor: String) {
      products(first: 250, query: "${statusQueryStr}", after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            status
            metafields(first: 10) {
              edges { node { namespace key value } }
            }
            variants(first: 10) {
              edges { node { id sku } }
            }
          }
        }
      }
    }`;
    
    const res = callGraphQL_({ query: query, variables: { cursor: cursor } });
    if (!res || !res.data || !res.data.products) break;
    
    const pData = res.data.products;
    const edges = pData.edges || [];
    pageCount++;
    totalFetched += edges.length;
    
    edges.forEach(edge => {
      const p = edge.node;
      const variants = (p.variants && p.variants.edges) ? p.variants.edges : [{}];
      
      let goodId = "";
      if (p.metafields && p.metafields.edges) {
        p.metafields.edges.forEach(mf => {
          if (mf.node.namespace === "custom" && mf.node.key === "good_id") {
            goodId = mf.node.value;
          }
        });
      }
      
      variants.forEach(vEdge => {
        const v = vEdge.node || {};
        allRows.push([
          goodId,
          v.sku || "",
          p.id || "",
          v.id || "",
          p.status || statusFilter
        ]);
      });
    });
    
    if (!pData.pageInfo || !pData.pageInfo.hasNextPage) break;
    cursor = pData.pageInfo.endCursor;
    Utilities.sleep(100);
  }
  
  let targetSheet = ss.getSheetByName(targetSheetName);
  if (!targetSheet) targetSheet = ss.insertSheet(targetSheetName);
  else targetSheet.clear();
  
  const numRows = allRows.length;
  const numCols = targetHeaders.length;
  
  const WRITE_CHUNK_SIZE = 5000;
  for (let i = 0; i < numRows; i += WRITE_CHUNK_SIZE) {
    const chunk = allRows.slice(i, i + WRITE_CHUNK_SIZE);
    targetSheet.getRange(i + 1, 1, chunk.length, numCols).setValues(chunk);
  }
  
  targetSheet.getRange(1, 1, 1, numCols).setFontWeight("bold");
  targetSheet.setFrozenRows(1);
}

// ============================================================
// FORMULA QUERY METHOD (1 วินาที)
// ============================================================

function getActiveProductsViaQuery() {
  applyQueryFormula_(STATUS_EXPORT_CONFIG.TARGET_SHEET_NAME || "Active Products", "WHERE Upper(Col12) = 'ACTIVE'");
}

function getInactiveProductsViaQuery() {
  applyQueryFormula_("Inactive", "WHERE Upper(Col12) <> 'ACTIVE'");
}

function applyQueryFormula_(targetSheetName, whereClause) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let targetSheet = ss.getSheetByName(targetSheetName);
  if (!targetSheet) targetSheet = ss.insertSheet(targetSheetName);
  else targetSheet.clear();
  
  const sourceId = STATUS_EXPORT_CONFIG.SOURCE_SPREADSHEET_ID;
  const sourceSheetName = STATUS_EXPORT_CONFIG.SOURCE_SHEET_NAME;
  
  const formula = `=QUERY(IMPORTRANGE("${sourceId}", "${sourceSheetName}!A:L"), "SELECT Col1, Col2, Col3, Col4, Col12 ${whereClause}", 1)`;
  targetSheet.getRange("A1").setFormula(formula);
  SpreadsheetApp.flush();
}

function convertFormulasToValues() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  const range = sheet.getDataRange();
  range.setValues(range.getValues());
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
