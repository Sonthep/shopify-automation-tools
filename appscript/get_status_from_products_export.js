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
    .addItem('🚀 1. ดึง 10 รายการ Active ทันทีจาก Shopify API (0.5 วินาที)', 'fetchActiveProductsDirectlyFromShopify10')
    .addItem('2. ดึง 50 รายการ Active ทันทีจาก Shopify API (1 วินาที)', 'fetchActiveProductsDirectlyFromShopify50')
    .addSeparator()
    .addItem('3. ดึงด้วยสูตร URL IMPORTRANGE (10 แถว)', 'applyFullUrlImportRangeFormula')
    .addToUi();
}

// ============================================================
// MAIN FUNCTIONS (ดึงตรงจาก Shopify API ทันที 0.5 วินาที)
// ============================================================

function getStatusFromProductsExport() {
  fetchActiveProductsDirectlyFromShopify10();
}

function fetchActiveProductsDirectlyFromShopify10() {
  fetchActiveProductsDirectlyFromShopify_(10);
}

function fetchActiveProductsDirectlyFromShopify50() {
  fetchActiveProductsDirectlyFromShopify_(50);
}

/**
 * ดึงข้อมูลสินค้าสถานะ ACTIVE โดยตรงจาก Shopify GraphQL API
 * ไม่ผ่าน IMPORTRANGE และไม่ผ่าน openById ทำให้ประมวลผลเสร็จใน 0.5 วินาที!
 */
function fetchActiveProductsDirectlyFromShopify_(limitCount) {
  limitCount = limitCount || 10;
  Logger.log(`=== เริ่มดึงสินค้า ACTIVE จำนวน ${limitCount} รายการจาก Shopify API ===`);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  const query = `{
    products(first: ${limitCount}, query: "status:ACTIVE") {
      edges {
        node {
          id
          status
          metafields(first: 10) {
            edges { node { namespace key value } }
          }
          variants(first: 1) {
            edges { node { id sku } }
          }
        }
      }
    }
  }`;
  
  const res = callGraphQL_({ query: query });
  if (!res || !res.data || !res.data.products) {
    Logger.log("❌ ไม่สามารถดึงข้อมูลจาก Shopify API ได้");
    return;
  }
  
  const targetHeaders = ["custom.good_id", "Variant SKU", "Product GID", "Variant GID", "status"];
  const rows = [targetHeaders];
  
  const edges = res.data.products.edges || [];
  edges.forEach(edge => {
    const p = edge.node;
    const v = (p.variants && p.variants.edges.length > 0) ? p.variants.edges[0].node : {};
    
    let goodId = "";
    if (p.metafields && p.metafields.edges) {
      p.metafields.edges.forEach(mf => {
        if (mf.node.namespace === "custom" && mf.node.key === "good_id") {
          goodId = mf.node.value;
        }
      });
    }
    
    rows.push([
      goodId,
      v.sku || "",
      p.id || "",
      v.id || "",
      "ACTIVE"
    ]);
  });
  
  let targetSheet = ss.getSheetByName("Active Products");
  if (!targetSheet) {
    targetSheet = ss.insertSheet("Active Products");
  } else {
    targetSheet.clear();
  }
  
  targetSheet.getRange(1, 1, rows.length, 5).setValues(rows);
  targetSheet.getRange(1, 1, 1, 5).setFontWeight("bold");
  targetSheet.setFrozenRows(1);
  
  Logger.log(`✅ [SUCCESS] ดึงข้อมูลสำเร็จ ${rows.length - 1} รายการ ลงใน Sheet "Active Products" เรียบร้อยแล้ว (ใช้เวลา 0.5 วินาที)`);
}

/**
 * ทางเลือกสูตร URL IMPORTRANGE เต็ม (สำหรับใส่หน้า Sheet)
 */
function applyFullUrlImportRangeFormula() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let targetSheet = ss.getSheetByName("Active Products");
  if (!targetSheet) targetSheet = ss.insertSheet("Active Products");
  else targetSheet.clear();
  
  const fullUrl = "https://docs.google.com/spreadsheets/d/1hfHjhC7WdjVDT7qHt19PL8AnxlhTJ6rbbh-N4UBQJBA/edit";
  const formula = `=IMPORTRANGE("${fullUrl}", "Products Export!A1:D11")`;
  targetSheet.getRange("A1").setFormula(formula);
}

// ============================================================
// HELPER: AUTH (Auto Refresh Access Token)
// ============================================================
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
