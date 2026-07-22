// ============================================================
// CONFIG & CREDENTIALS (Scoped object to prevent clashes with other gs files)
// ============================================================
var STATUS_EXPORT_CONFIG = {
  SHOP: "sevenfive-4062.myshopify.com",
  CLIENT_ID: "xxxxxxxxxxxxxxxxxxx",
  CLIENT_SECRET: "xxxxxxxxxxxxxxxxxxx",
  SOURCE_SPREADSHEET_ID: "1hfHjhC7WdjVDT7qHt19PL8AnxlhTJ6rbbh-N4UBQJBA",
  SOURCE_SHEET_NAME: "Products Export",
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
    .addItem('🚀 1. ดึงสินค้า Active ทั้งหมด (Full Version - จาก Shopify API)', 'fetchAllActiveProductsFull')
    .addItem('🚀 2. ดึงสินค้า Inactive ทั้งหมด (Full Version - จาก Shopify API)', 'fetchAllInactiveProductsFull')
    .addSeparator()
    .addItem('3. ดึงสินค้า Active ทั้งหมด (สูตร QUERY IMPORTRANGE - 1 วินาที)', 'getActiveProductsViaQuery')
    .addItem('4. ดึงสินค้า Inactive ทั้งหมด (สูตร QUERY IMPORTRANGE - 1 วินาที)', 'getInactiveProductsViaQuery')
    .addSeparator()
    .addItem('5. แปลงสูตรใน Sheet ปัจจุบันเป็นข้อความปกติ (Freeze Values)', 'convertFormulasToValues')
    .addToUi();
}

// ============================================================
// MAIN FUNCTIONS
// ============================================================

/**
 * ดึงสินค้าสถานะ ACTIVE ทั้งหมดแบบ FULL VERSION (ฟังก์ชั่นเดิมเพื่อรองรับการเรียกใช้)
 */
function getStatusFromProductsExport() {
  fetchAllActiveProductsFull();
}

/**
 * ดึงสินค้าสถานะ INACTIVE ทั้งหมดแบบ FULL VERSION (ฟังก์ชั่นเดิมเพื่อรองรับการเรียกใช้)
 */
function getInactiveStatusFromProductsExport() {
  fetchAllInactiveProductsFull();
}

/**
 * ดึงสินค้าสถานะ ACTIVE ทั้งหมดแบบ FULL VERSION ตรงจาก Shopify API
 */
function fetchAllActiveProductsFull() {
  fetchProductsFromShopifyByStatus_("ACTIVE", "Active Products");
}

/**
 * ดึงสินค้าสถานะ INACTIVE / DRAFT ทั้งหมดแบบ FULL VERSION ตรงจาก Shopify API
 */
function fetchAllInactiveProductsFull() {
  fetchProductsFromShopifyByStatus_("DRAFT", "Inactive");
}

// ============================================================
// CORE PROCESSING LOGIC (Paginated GraphQL Fetch + Chunk Write)
// ============================================================

function fetchProductsFromShopifyByStatus_(statusFilter, targetSheetName) {
  Logger.log(`=== เริ่มดึงสินค้าสถานะ [${statusFilter}] ทั้งหมดแบบ FULL VERSION จาก Shopify API ===`);
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
    if (!res || !res.data || !res.data.products) {
      Logger.log("❌ ไม่สามารถดึงข้อมูลจาก Shopify API ได้ที่หน้า " + (pageCount + 1));
      break;
    }
    
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
    
    Logger.log(`  หน้า ${pageCount}: ดึงแล้ว ${edges.length} สินค้า (รวมสะสม ${totalFetched} สินค้า / ${allRows.length - 1} ตารางแถว)`);
    
    if (!pData.pageInfo || !pData.pageInfo.hasNextPage) {
      break;
    }
    cursor = pData.pageInfo.endCursor;
    Utilities.sleep(100);
  }
  
  if (allRows.length <= 1) {
    Logger.log("⚠️ ไม่พบข้อมูลสินค้าสถานะ " + statusFilter);
    return;
  }
  
  Logger.log(`📊 ดึงข้อมูลเสร็จสิ้น! กำลังเขียนข้อมูลทั้งหมด ${allRows.length - 1} แถวลงใน Sheet "${targetSheetName}"...`);
  
  let targetSheet = ss.getSheetByName(targetSheetName);
  if (!targetSheet) {
    targetSheet = ss.insertSheet(targetSheetName);
  } else {
    targetSheet.clear();
  }
  
  const numRows = allRows.length;
  const numCols = targetHeaders.length;
  
  const currentRows = targetSheet.getMaxRows();
  const currentCols = targetSheet.getMaxColumns();
  
  if (currentCols < numCols) {
    targetSheet.insertColumnsAfter(currentCols, numCols - currentCols);
  } else if (currentCols > numCols) {
    targetSheet.deleteColumns(numCols + 1, currentCols - numCols);
  }
  
  if (currentRows < numRows) {
    targetSheet.insertRowsAfter(currentRows, numRows - currentRows);
  } else if (currentRows > numRows) {
    targetSheet.deleteRows(numRows + 1, currentRows - numRows);
  }
  
  // เขียนข้อมูลแบบแบ่ง Chunk ละ 5,000 แถว
  const WRITE_CHUNK_SIZE = 5000;
  for (let i = 0; i < numRows; i += WRITE_CHUNK_SIZE) {
    const chunk = allRows.slice(i, i + WRITE_CHUNK_SIZE);
    targetSheet.getRange(i + 1, 1, chunk.length, numCols).setValues(chunk);
  }
  
  targetSheet.getRange(1, 1, 1, numCols).setFontWeight("bold");
  targetSheet.setFrozenRows(1);
  
  const successMsg = `✅ [FULL VERSION SUCCESS] ดึงสินค้าสถานะ ${statusFilter} สำเร็จทั้งหมด ${allRows.length - 1} แถว ลงใน Sheet "${targetSheetName}"`;
  Logger.log(successMsg);
  writeStatusLog_(targetSheetName, allRows.length - 1, allRows.length - 1, 0, successMsg);
}

// ============================================================
// FORMULA QUERY METHOD (สูตร QUERY IMPORTRANGE 1 วินาที)
// ============================================================

function getActiveProductsViaQuery() {
  applyQueryFormula_("Active Products", "WHERE Upper(Col12) = 'ACTIVE'");
}

function getInactiveProductsViaQuery() {
  applyQueryFormula_("Inactive", "WHERE Upper(Col12) <> 'ACTIVE'");
}

function applyQueryFormula_(targetSheetName, whereClause) {
  Logger.log(`=== เริ่มใส่สูตร QUERY ดึงสินค้า [${targetSheetName}] ===`);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  let targetSheet = ss.getSheetByName(targetSheetName);
  if (!targetSheet) {
    targetSheet = ss.insertSheet(targetSheetName);
  } else {
    targetSheet.clear();
  }
  
  const sourceId = STATUS_EXPORT_CONFIG.SOURCE_SPREADSHEET_ID;
  const sourceSheetName = STATUS_EXPORT_CONFIG.SOURCE_SHEET_NAME;
  
  const formula = `=QUERY(IMPORTRANGE("${sourceId}", "${sourceSheetName}!A:L"), "SELECT Col1, Col2, Col3, Col4, Col12 ${whereClause}", 1)`;
  
  targetSheet.getRange("A1").setFormula(formula);
  SpreadsheetApp.flush();
  
  Logger.log(`✅ ใส่สูตรลงใน Sheet "${targetSheetName}" เซลล์ A1 เรียบร้อยแล้ว!`);
}

function convertFormulasToValues() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  const range = sheet.getDataRange();
  range.setValues(range.getValues());
  Logger.log("✅ แปลงสูตรใน Sheet " + sheet.getName() + " เป็นค่าข้อความปกติเรียบร้อยแล้ว");
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
  } catch (e) {
    Logger.log("⚠️ Could not write log: " + e);
  }
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
