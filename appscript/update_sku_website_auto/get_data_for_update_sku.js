// ============================================================
// Script: get_data_for_update_sku
// ดึงข้อมูล Variant SKU จาก Shopify นำมาเทียบ Winspeed และ กรองลง update_sku
// ============================================================

const TARGET_SHEET_NAME_SKU = "update_sku";
const WINSPEED_FILE_ID_SKU = "1-7ap--3aphttTb8M0cXYvVYmRGtZQKRxoUW3nvwuUNA";

const PROP_ACCESS_TOKEN_SKU = "ACCESS_TOKEN";
const PROP_TOKEN_EXPIRY_SKU = "TOKEN_EXPIRY";
const PROP_LAST_BULK_OP_ID_SKU = "LAST_BULK_OP_ID_SKU";


// ============================================================
// MAIN FUNCTION
// ============================================================
function getDataForUpdateSku() {
  Logger.log("=== เริ่มดึงข้อมูลสำหรับ Update SKU จาก Shopify ===");
  const props = PropertiesService.getScriptProperties();
  let opId = props.getProperty(PROP_LAST_BULK_OP_ID_SKU);
  
  if (!opId) {
    Logger.log("Starting a new bulk query for SKU...");
    opId = startBulkQuerySku_();
    if (!opId) {
      Logger.log("❌ ไม่สามารถเริ่มการดึงข้อมูลจาก Shopify ได้ โปรดตรวจสอบ Log");
      return;
    }
    props.setProperty(PROP_LAST_BULK_OP_ID_SKU, opId);
    Logger.log("New bulk operation started: " + opId);
  }
  
  // ตรวจสอบสถานะและรอชั่วคราว (สูงสุด 45 วินาที)
  const result = pollStatusSku_(opId);
  
  if (result.status === "COMPLETED") {
    props.deleteProperty(PROP_LAST_BULK_OP_ID_SKU);
    downloadAndProcessSkuJSONL_(result.url);
    Logger.log("✅ ดึงข้อมูลสินค้าและเขียนลงชีต '" + TARGET_SHEET_NAME_SKU + "' เรียบร้อยแล้ว!");
  } else if (result.status === "RUNNING" || result.status === "CREATED") {
    Logger.log(
      "⏳ ข้อมูลกำลังจัดเตรียมอยู่บน Shopify...\n\n" +
      "กรุณารอ 1-2 นาที แล้วกดรันคำสั่งอีกครั้งเพื่อทำการโหลดลงชีต"
    );
  } else {
    // ล้มเหลวหรือถูกยกเลิก (FAILED, CANCELED)
    props.deleteProperty(PROP_LAST_BULK_OP_ID_SKU);
    Logger.log("❌ การประมวลผลบน Shopify ล้มเหลว (สถานะ: " + result.status + ")\nโปรดกดรันอีกครั้งเพื่อเริ่มทำรายการใหม่");
  }
}

// ============================================================
// 1. ส่งคำสั่ง Bulk Operation ไปยัง Shopify
// ============================================================
function startBulkQuerySku_() {
  const query = `mutation {
    bulkOperationRunQuery(
      query: """
        {
          products {
            edges {
              node {
                id
                goodId: metafield(namespace: "custom", key: "good_id") {
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
      bulkOperation {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }`;
  
  const res = callShopifyGraphQL_(query);
  if (res && res.data && res.data.bulkOperationRunQuery) {
    const runRes = res.data.bulkOperationRunQuery;
    if (runRes.userErrors && runRes.userErrors.length > 0) {
      Logger.log("[ERROR] Bulk Query UserErrors: " + JSON.stringify(runRes.userErrors));
      return null;
    }
    return runRes.bulkOperation.id;
  }
  return null;
}

// ============================================================
// 2. วนลูปเช็คสถานะ
// ============================================================
function pollStatusSku_(bulkOperationId) {
  const payload = {
    query: `query {
      node(id: "${bulkOperationId}") {
        ... on BulkOperation {
          status
          objectCount
          url
        }
      }
    }`
  };
  
  const maxPollTimeMs = 45000; 
  const start = Date.now();
  
  while (true) {
    const res = callShopifyGraphQL_(payload);
    const op = (res && res.data && res.data.node) ? res.data.node : null;
    
    if (!op) {
      Logger.log("[ERROR] Bulk operation not found for ID: " + bulkOperationId);
      return { status: "NOT_FOUND" };
    }
    
    Logger.log(`  [${op.status}] ${op.objectCount} objects`);
    
    if (op.status === "COMPLETED") {
      return { status: "COMPLETED", url: op.url };
    }
    if (op.status !== "RUNNING" && op.status !== "CREATED") {
      return { status: op.status };
    }
    
    if (Date.now() - start > maxPollTimeMs) {
      Logger.log("Polling timeout reached (AppScript max limit prevention). Returning current status.");
      return { status: op.status };
    }
    
    Utilities.sleep(5000); 
  }
}

// ============================================================
// 3. ดาวน์โหลด JSONL และเขียนลง Sheet
// ============================================================
function downloadAndProcessSkuJSONL_(url) {
  if (!url) {
    Logger.log("[ERROR] No URL provided for download.");
    return;
  }
  
  Logger.log("Downloading JSONL from Shopify...");
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    Logger.log("[ERROR] Failed to download JSONL: HTTP " + response.getResponseCode());
    return;
  }
  
  const content = response.getContentText();
  const lines = content.split("\n");
  
  // 1. ดึงข้อมูล VLOOKUP Winspeed Sku Map
  const winspeedMap = fetchWinspeedSkuMap_();
  
  // 2. แปลงข้อมูล JSONL
  const targetHeaders = ["Good ID", "website sku", "winspeed sku", "check update", "Product GID", "Variant GID"];
  const targetRows = [targetHeaders];
  
  // โครงสร้างของ Bulk Query results 
  // Object Product (มี __parentId เป็น null) -> Object Metafield (ถ้ามี) -> Object Variant
  
  let currentProductId = null;
  let currentGoodId = "";
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    try {
      const obj = JSON.parse(line);
      
      // กรณีนี้เป็น Product Node
      if (obj.id && obj.id.startsWith("gid://shopify/Product/")) {
        currentProductId = obj.id;
        currentGoodId = obj.goodId ? obj.goodId.value : "";
      }
      
      // กรณีเป็น Metafield Node (ปกติถ้ามีมันจะต่อท้าย Product แต่ใช้แบบ nested query ค่าจะรวมมาให้เลย)
      // โชคดีที่เรา query `goodId: metafield(...)` ไว้ใน Product node เลย
      
      // กรณีเป็น Variant Node
      if (obj.id && obj.id.startsWith("gid://shopify/ProductVariant/") && obj.__parentId) {
        // หาก id ตรงกับ parent
        if (obj.__parentId === currentProductId) {
          const variantGid = obj.id;
          const websiteSku = String(obj.sku || "").trim();
          const goodId = String(currentGoodId).trim();
          
          if (!goodId && !websiteSku) continue;
          
          const winspeedSku = winspeedMap.get(goodId) || "";
          
          const r = targetRows.length + 1; // ลำดับแถว 1-indexed สำหรับสูตรเช็ค (รวม Header แล้ว)
          const checkFormula = `=B${r}=C${r}`; 
          
          targetRows.push([
            goodId,
            websiteSku,
            winspeedSku,
            checkFormula,
            currentProductId,
            variantGid
          ]);
        }
      }
    } catch (e) {
      Logger.log("JSON Parse Error at line " + i + ": " + e.message);
    }
  }
  
  // 3. เขียนข้อมูลลงไฟล์ปัจจุบัน
  const targetSs = SpreadsheetApp.getActiveSpreadsheet();
  let targetSheet = targetSs.getSheetByName(TARGET_SHEET_NAME_SKU);
  
  if (!targetSheet) {
    targetSheet = targetSs.insertSheet(TARGET_SHEET_NAME_SKU);
  } else {
    targetSheet.clear(); 
  }
  
  const numRows = targetRows.length;
  const numCols = targetHeaders.length;
  
  targetSheet.getRange(1, 1, numRows, numCols).setValues(targetRows);
  targetSheet.getRange(1, 1, 1, numCols).setFontWeight("bold");
  targetSheet.setFrozenRows(1);
  
  const msg = `✅ ดึงข้อมูลอัปเดต SKU สำเร็จ ${numRows - 1} รายการ (เชื่อมข้อมูลตรงจาก Shopify 🚀)`;
  Logger.log(msg);
}

// ============================================================
// ดึงข้อมูล Vlookup (Col B -> Col C) จากไฟล์ Winspeed
// ============================================================
function fetchWinspeedSkuMap_() {
  const map = new Map();
  try {
    const ws = SpreadsheetApp.openById(WINSPEED_FILE_ID_SKU);
    const sheetNames = ["Active", "Inactive"];
    
    sheetNames.forEach(sheetName => {
      const sheet = ws.getSheetByName(sheetName);
      if (sheet) {
        const lastRow = sheet.getLastRow();
        if (lastRow >= 2) {
          const values = sheet.getRange(2, 2, lastRow - 1, 2).getValues();
          for (let i = 0; i < values.length; i++) {
            const goodId = String(values[i][0] || "").trim(); // Col B
            const goodCode = String(values[i][1] || "").trim(); // Col C
            if (goodId && !map.has(goodId)) {
              map.set(goodId, goodCode);
            }
          }
        }
      }
    });
    Logger.log(`📌 สร้าง VLOOKUP Map จาก Winspeed สำเร็จ: ${map.size} รายการ`);
  } catch (e) {
    Logger.log(`⚠️ ไม่สามารถดึงข้อมูล VLOOKUP จาก Winspeed ได้: ${e.message}`);
  }
  return map;
}

// ============================================================
// GRAPHQL CALLER (มีระบบขอ Token ใหม่ ถ้า Token หมดอายุ)
// ============================================================
function callShopifyGraphQL_(queryOrPayload) {
  // 🔴 🔴 🔴 ตั้งค่า Token ตรงนี้ได้เลยครับ 🔴 🔴 🔴
  // หากคุณมี Token ที่ขึ้นต้นด้วย shpat_ ให้นำมาใส่ในเครื่องหมายคำพูดด้านล่างนี้ได้เลยครับ
  const HARDCODED_SHPAT_TOKEN = ""; 
  
  // หรือถ้าใช้แบบ Client Secret ให้ใส่ตรงนี้
  const HARDCODED_CLIENT_SECRET = "";

  const SHOP = PropertiesService.getScriptProperties().getProperty("SHOP") || "sevenfive-4062.myshopify.com";
  const CLIENT_ID = PropertiesService.getScriptProperties().getProperty("CLIENT_ID") || "696e1e9162c702cc07c2f94a1beacf8a";
  const CLIENT_SECRET = HARDCODED_CLIENT_SECRET || PropertiesService.getScriptProperties().getProperty("CLIENT_SECRET");

  let payload;
  if (typeof queryOrPayload === "string") {
    payload = { query: queryOrPayload };
  } else if (typeof queryOrPayload === "object") {
    payload = queryOrPayload;
  } else {
    throw new Error("Invalid GraphQL payload");
  }

  const endpoint = `https://${SHOP}/admin/api/2025-01/graphql.json`;

  function getAccessToken() {
    const props = PropertiesService.getScriptProperties();
    const token = HARDCODED_SHPAT_TOKEN || props.getProperty(PROP_ACCESS_TOKEN_SKU);
    const expiry = Number(props.getProperty(PROP_TOKEN_EXPIRY_SKU) || 0);

    if (token) {
      // ถ้านี่คือ Permanent Token (Custom App) ที่ไม่มีวันหมดอายุ
      if (token.startsWith("shpat_")) return token;
      
      // ถ้าเป็น Token ทั่วไป และยังไม่หมดอายุ
      if (Date.now() < expiry - 300000) return token;
    }
    
    Logger.log("Token expired or not found. Requesting new token from Shopify...");
    const url = `https://${SHOP}/admin/oauth/access_token`;
    const options = {
      method: "post",
      contentType: "application/x-www-form-urlencoded",
      payload: `grant_type=client_credentials&client_id=${encodeURIComponent(CLIENT_ID)}&client_secret=${encodeURIComponent(CLIENT_SECRET)}`,
      muteHttpExceptions: true
    };
    
    const res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    const text = res.getContentText();
    
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`❌ Token request failed (HTTP ${code}). Shopify returned HTML instead of JSON. Check your SHOP, CLIENT_ID, and CLIENT_SECRET. Response snippet: ` + text.substring(0, 150));
    }
    
    if (data.access_token) {
      const newExpiry = Date.now() + ((Number(data.expires_in) || 3600) * 1000);
      props.setProperty(PROP_ACCESS_TOKEN_SKU, data.access_token);
      props.setProperty(PROP_TOKEN_EXPIRY_SKU, String(newExpiry));
      return data.access_token;
    }
    throw new Error("Failed to get Shopify Access Token");
  }

  let maxRetries = 3;
  let waitMs = 2000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const token = getAccessToken();
    const options = {
      method: "post",
      contentType: "application/json",
      headers: { "X-Shopify-Access-Token": token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
    
    const res = UrlFetchApp.fetch(endpoint, options);
    const code = res.getResponseCode();
    
    if (code === 401) {
      PropertiesService.getScriptProperties().deleteProperty(PROP_ACCESS_TOKEN_SKU);
      Utilities.sleep(1000);
      continue;
    }
    
    if (code !== 200) {
      Logger.log("[ERROR] GraphQL HTTP " + code + ": " + res.getContentText());
      return null;
    }
    
    const json = JSON.parse(res.getContentText());
    
    if (json.errors) {
      const isThrottled = json.errors.every(e => e.extensions && e.extensions.code === "THROTTLED");
      if (isThrottled) {
        Logger.log("[THROTTLED] Retrying in " + waitMs + " ms...");
        Utilities.sleep(waitMs);
        waitMs *= 2;
        continue;
      } else {
        Logger.log("[ERROR] GraphQL execution errors: " + JSON.stringify(json.errors));
        return null;
      }
    }
    return json;
  }
  return null;
}

// ============================================================
// FUNCTION 2: UPDATE SKU TO SHOPIFY
// ============================================================
function updateDataToShopifySku() {
  Logger.log("=== เริ่มต้นอัปเดต SKU ไปยัง Shopify ===");
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TARGET_SHEET_NAME_SKU);
  if (!sheet) {
    Logger.log("❌ ไม่พบ Sheet ชื่อ " + TARGET_SHEET_NAME_SKU);
    return;
  }
  
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  
  if (lastRow < 2) {
    Logger.log("⚠️ ไม่มีข้อมูลให้อัปเดต");
    return;
  }
  
  const data = sheet.getRange(1, 1, lastRow, Math.max(lastCol, 6)).getValues(); 
  const headers = data[0].map(h => String(h).trim().toLowerCase());
  
  const webSkuIdx = headers.indexOf("website sku");
  const winSkuIdx = headers.indexOf("winspeed sku");
  const checkUpdateIdx = headers.indexOf("check update");
  const pGidIdx = headers.findIndex(h => h.includes("product gid") || h === "product_gid");
  const vGidIdx = headers.findIndex(h => h.includes("variant gid") || h === "variant_gid");
  
  let statusIdx = headers.findIndex(h => h.includes("status"));
  if (statusIdx === -1) {
    statusIdx = headers.length; 
    sheet.getRange(1, statusIdx + 1).setValue("Update Status").setFontWeight("bold");
  }

  const statusUpdates = new Array(lastRow - 1).fill([""]);
  let updateCount = 0;
  let failCount = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const webSku = webSkuIdx !== -1 && row[webSkuIdx] != null ? String(row[webSkuIdx]).trim() : "";
    const winSku = winSkuIdx !== -1 && row[winSkuIdx] != null ? String(row[winSkuIdx]).trim() : "";
    const checkUpdate = checkUpdateIdx !== -1 && row[checkUpdateIdx] != null ? String(row[checkUpdateIdx]).trim().toUpperCase() : "";
    const pGid = pGidIdx !== -1 && row[pGidIdx] != null ? String(row[pGidIdx]).trim() : "";
    const vGid = vGidIdx !== -1 && row[vGidIdx] != null ? String(row[vGidIdx]).trim() : "";
    
    if (!webSku || !winSku || checkUpdate !== "FALSE") {
      statusUpdates[i - 1] = ["⏭️ ข้าม (ไม่เข้าเงื่อนไข)"];
      continue;
    }
    
    if (!pGid.startsWith("gid://shopify/Product/") || !vGid.startsWith("gid://shopify/ProductVariant/")) {
      statusUpdates[i - 1] = ["❌ ข้อมูล GID ไม่ถูกต้อง"];
      continue;
    }
    
    const mutation = `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { field message }
      }
    }`;
    
    const variables = {
      productId: pGid,
      variants: [{ id: vGid, inventoryItem: { sku: winSku } }]
    };
    
    const res = callShopifyGraphQL_({ query: mutation, variables: variables });
    
    if (res && res.data && res.data.productVariantsBulkUpdate) {
      const errors = res.data.productVariantsBulkUpdate.userErrors || [];
      if (errors.length > 0) {
        statusUpdates[i - 1] = ["❌ Error: " + errors.map(e => e.message).join(", ")];
        failCount++;
      } else {
        const nowStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");
        statusUpdates[i - 1] = [`✅ อัปเดตสำเร็จ (${nowStr})`];
        updateCount++;
      }
    } else {
      statusUpdates[i - 1] = ["❌ API Error (เชื่อมต่อไม่สำเร็จ)"];
      failCount++;
    }
    
    Utilities.sleep(150); 
  }
  
  sheet.getRange(2, statusIdx + 1, statusUpdates.length, 1).setValues(statusUpdates);
  Logger.log(`🎉 อัปเดตเสร็จสิ้น: สำเร็จ ${updateCount} รายการ, ล้มเหลว ${failCount} รายการ`);
}
