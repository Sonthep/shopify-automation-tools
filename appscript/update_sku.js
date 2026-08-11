// ============================================================
// CONFIG & CREDENTIALS
// ============================================================
var SHOPIFY_SKU_CONFIG = {
  SHOP: "sevenfive-4062.myshopify.com",
  CLIENT_ID: "696e1e9162c702cc07c2f94a1beacf8a",
  CLIENT_SECRET: "YOUR_CLIENT_SECRET", // ⚠️ ถูกลบออกเพื่อความปลอดภัยตอน Push กรุณาใส่กลับใน Apps Script
  TARGET_SHEET: "update_sku", // ชื่อ Sheet สำหรับดึงข้อมูลอัปเดต SKU
  LOG_SHEET_NAME: "Log run script",
  BATCH_SIZE: 50, // จำนวน variants ต่อ 1 Direct API Call (สำหรับ Direct Batch Method)
  PROP_ACCESS_TOKEN: "ACCESS_TOKEN",
  PROP_TOKEN_EXPIRY: "TOKEN_EXPIRY"
};

// ============================================================
// UI MENU
// ============================================================
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('📦 Shopify SKU Tools')
    .addItem('🚀 1. อัปเดต SKU แบบเร็วที่สุด (Bulk Mutation - รวดเดียว 5 วินาที)', 'updateVariantSkusBulkMutation')
    .addSeparator()
    .addItem('2. อัปเดต SKU แบบ Direct Batch (ทีละรายการ)', 'updateVariantSkusFromActiveSheet')
    .addToUi();
}

// ============================================================
// ULTRA-FAST BULK MUTATION METHOD (Shopify Bulk Operation API)
// ============================================================
/**
 * อัปเดต Variant SKU บน Shopify แบบเร็วที่สุดในโลก (Bulk Mutation API)
 * รองรับระดับหมื่นรายการ รวดเดียวเสร็จภายในไม่กี่วินาทีบน Apps Script
 */
function updateVariantSkusBulkMutation() {
  Logger.log("=== เริ่มต้นอัปเดต SKU แบบ Bulk Operation API (ความเร็วสูงสุด) ===");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHOPIFY_SKU_CONFIG.TARGET_SHEET);
  if (!sheet) {
    sheet = ss.getActiveSheet();
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (lastRow < 2) {
    const emptyMsg = `⚠️ ไม่พบข้อมูลสำหรับอัปเดตใน Sheet '${sheet.getName()}'`;
    Logger.log(emptyMsg);
    showAlert_(emptyMsg);
    writeSkuRunLogToSheet_(sheet.getName(), 0, 0, 0, emptyMsg);
    return;
  }

  // 1. อ่านข้อมูลทั้งหมดจาก Sheet
  const data = sheet.getRange(1, 1, lastRow, Math.max(lastCol, 4)).getValues();
  const headers = data[0].map(h => String(h).trim());
  const rows = data.slice(1);

  const webSkuIdx = findSkuColIndex_(headers, ["website sku"]);
  const winSkuIdx = findSkuColIndex_(headers, ["winspeed sku"]);
  const checkUpdateIdx = findSkuColIndex_(headers, ["check update"]);
  const pGidIdx = findSkuColIndex_(headers, ["Product GID", "ProductGID", "product_gid"]);
  const vGidIdx = findSkuColIndex_(headers, ["Variant GID", "VariantGID", "variant_gid"]);

  const finalPGidIdx = pGidIdx !== -1 ? pGidIdx : 4;
  const finalVGidIdx = vGidIdx !== -1 ? vGidIdx : 5;

  const jsonlLines = [];
  let skipped = 0;

  rows.forEach(row => {
    const webSku = webSkuIdx !== -1 && row[webSkuIdx] != null ? String(row[webSkuIdx]).trim() : "";
    const winSku = winSkuIdx !== -1 && row[winSkuIdx] != null ? String(row[winSkuIdx]).trim() : "";
    const checkUpdate = checkUpdateIdx !== -1 && row[checkUpdateIdx] != null ? String(row[checkUpdateIdx]).trim().toUpperCase() : "";
    
    const pGid = finalPGidIdx !== -1 && row[finalPGidIdx] != null ? String(row[finalPGidIdx]).trim() : "";
    const vGid = finalVGidIdx !== -1 && row[finalVGidIdx] != null ? String(row[finalVGidIdx]).trim() : "";

    // เงื่อนไข: ต้องมีทั้ง website sku และ winspeed sku และ check update = false ถึงจะเอา winspeed sku ส่ง update
    if (webSku && winSku && checkUpdate === "FALSE" && pGid.startsWith("gid://shopify/Product/") && vGid.startsWith("gid://shopify/ProductVariant/")) {
      const payloadObj = {
        productId: pGid,
        variants: [{
          id: vGid,
          inventoryItem: {
            sku: winSku
          }
        }]
      };
      jsonlLines.push(JSON.stringify(payloadObj));
    } else {
      skipped++;
    }
  });

  const totalItems = jsonlLines.length;
  if (totalItems === 0) {
    const noValidMsg = "⚠️ ไม่พบรายการ GID และ SKU ที่ถูกต้องใน Sheet ปลายทาง";
    Logger.log(noValidMsg);
    showAlert_(noValidMsg);
    writeSkuRunLogToSheet_(sheet.getName(), 0, 0, 0, noValidMsg);
    return;
  }

  Logger.log(`📊 รวมข้อมูล JSONL พร้อมส่ง: ${totalItems} รายการ (ข้าม ${skipped} รายการที่ไม่สมบูรณ์)`);

  // 2. ขอ Staged Upload Target จาก Shopify
  const stageMutation = `mutation {
    stagedUploadsCreate(input: [{
      resource: BULK_MUTATION_VARIABLES,
      filename: "sku_bulk.jsonl",
      mimeType: "text/jsonl",
      httpMethod: PUT
    }]) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }`;

  const stageRes = callSkuGraphQL_(stageMutation);
  if (!stageRes || !stageRes.data || !stageRes.data.stagedUploadsCreate) {
    const errStage = "❌ สร้าง Staged Upload ล้มเหลว";
    Logger.log(errStage);
    showAlert_(errStage);
    writeSkuRunLogToSheet_(sheet.getName(), totalItems, 0, totalItems, errStage);
    return;
  }

  const target = stageRes.data.stagedUploadsCreate.stagedTargets[0];
  const uploadUrl = target.url;
  const resourceUrl = target.resourceUrl;
  const targetParams = target.parameters || [];

  // 3. Upload JSONL Payload ขึ้น Shopify Staged Target
  const jsonlContent = jsonlLines.join("\n") + "\n";
  Logger.log("📤 กำลังอัปโหลดไฟล์ JSONL ขนาด " + Math.round(jsonlContent.length / 1024) + " KB ขึ้น Shopify...");

  const putHeaders = { "Content-Type": "text/jsonl" };
  if (Array.isArray(targetParams)) {
    targetParams.forEach(p => { if (p && p.name && p.value !== undefined) putHeaders[p.name] = p.value; });
  }

  const putOptions = {
    method: "put",
    headers: putHeaders,
    payload: jsonlContent,
    muteHttpExceptions: true
  };

  const putRes = UrlFetchApp.fetch(uploadUrl, putOptions);
  if (putRes.getResponseCode() >= 400) {
    const errPut = `❌ Upload JSONL ล้มเหลว (HTTP ${putRes.getResponseCode()}: ${putRes.getContentText().substring(0, 200)})`;
    Logger.log(errPut);
    showAlert_(errPut);
    writeSkuRunLogToSheet_(sheet.getName(), totalItems, 0, totalItems, errPut);
    return;
  }

  Logger.log("✅ Upload JSONL สำเร็จ! กำลังสั่ง Shopify เริ่มทำงานในพื้นหลัง...");

  // 4. สั่ง Shopify รัน bulkOperationRunMutation
  const runMutation = `mutation bulkRun($stagedUploadPath: String!) {
    bulkOperationRunMutation(
      mutation: "mutation variantSkuUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id sku } userErrors { field message } } }",
      stagedUploadPath: $stagedUploadPath
    ) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }`;

  const runRes = callSkuGraphQL_(runMutation, { stagedUploadPath: resourceUrl });
  if (runRes && runRes.data && runRes.data.bulkOperationRunMutation) {
    const bulkOp = runRes.data.bulkOperationRunMutation.bulkOperation;
    const userErrors = runRes.data.bulkOperationRunMutation.userErrors || [];

    if (userErrors.length > 0) {
      const errRun = "❌ Bulk Operation เกิดข้อผิดพลาด: " + JSON.stringify(userErrors);
      Logger.log(errRun);
      showAlert_(errRun);
      writeSkuRunLogToSheet_(sheet.getName(), totalItems, 0, totalItems, errRun);
    } else if (bulkOp) {
      const nowStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT+7", "HH:mm:ss");
      const successMsg = `🚀 สั่งคำสั่ง Bulk Operation SKU สำเร็จ! (ID: ${bulkOp.id}, Status: ${bulkOp.status}) ทั้งหมด ${totalItems} รายการกำลังอัปเดตบน Shopify Cloud`;
      Logger.log(successMsg);
      
      // บันทึกสถานะลงในคอลัมน์ Update Status ของ Sheet
      let statusIdx = findSkuColIndex_(headers, ["Update Status", "Status", "Log"]);
      if (statusIdx === -1) {
        statusIdx = 4;
        sheet.getRange(1, statusIdx + 1).setValue("Update Status").setFontWeight("bold");
      }
      
      const statusUpdates = rows.map(row => {
        const webSku = webSkuIdx !== -1 && row[webSkuIdx] != null ? String(row[webSkuIdx]).trim() : "";
        const winSku = winSkuIdx !== -1 && row[winSkuIdx] != null ? String(row[winSkuIdx]).trim() : "";
        const checkUpdate = checkUpdateIdx !== -1 && row[checkUpdateIdx] != null ? String(row[checkUpdateIdx]).trim().toUpperCase() : "";
        const pGid = finalPGidIdx !== -1 && row[finalPGidIdx] != null ? String(row[finalPGidIdx]).trim() : "";
        const vGid = finalVGidIdx !== -1 && row[finalVGidIdx] != null ? String(row[finalVGidIdx]).trim() : "";
        
        if (webSku && winSku && checkUpdate === "FALSE" && pGid.startsWith("gid://shopify/Product/") && vGid.startsWith("gid://shopify/ProductVariant/")) {
          return `🚀 Bulk Scheduled (${nowStr})`;
        }
        return "⏭️ ข้าม (ไม่เข้าเงื่อนไข)";
      });
      
      writeStatusToSheet_(sheet, statusIdx, statusUpdates);
      showAlert_(successMsg);
      writeSkuRunLogToSheet_(sheet.getName(), totalItems, totalItems, 0, successMsg);
    }
  } else {
    const errRunFail = "❌ ไม่สามารถเริ่ม Bulk Operation SKU ได้";
    Logger.log(errRunFail);
    showAlert_(errRunFail);
    writeSkuRunLogToSheet_(sheet.getName(), totalItems, 0, totalItems, errRunFail);
  }
}

// ============================================================
// DIRECT BATCH METHOD (Legacy Direct GraphQL Call)
// ============================================================
/**
 * ดึงข้อมูลจาก Sheet 'update_sku' แล้วยิงอัปเดต SKU ไปยัง Shopify แบบ Direct Batch
 */
function updateVariantSkusFromActiveSheet() {
  Logger.log("=== เริ่มต้นอัปเดต SKU แบบ Direct Batch ===");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHOPIFY_SKU_CONFIG.TARGET_SHEET);
  
  if (!sheet) {
    Logger.log(`Sheet '${SHOPIFY_SKU_CONFIG.TARGET_SHEET}' not found. Fallback to active sheet '${ss.getActiveSheet().getName()}'.`);
    sheet = ss.getActiveSheet();
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (lastRow < 2) {
    const emptyMsg = `⚠️ ไม่พบข้อมูลสำหรับอัปเดตใน Sheet '${sheet.getName()}' (ต้องการอย่างน้อย 1 แถวข้อมูล)`;
    Logger.log(emptyMsg);
    showAlert_(emptyMsg);
    writeSkuRunLogToSheet_(sheet.getName(), 0, 0, 0, emptyMsg);
    return;
  }

  const range = sheet.getRange(1, 1, lastRow, Math.max(lastCol, 5));
  const data = range.getValues();
  const headers = data[0].map(h => String(h).trim());

  const webSkuIdx = findSkuColIndex_(headers, ["website sku"]);
  const winSkuIdx = findSkuColIndex_(headers, ["winspeed sku"]);
  const checkUpdateIdx = findSkuColIndex_(headers, ["check update"]);
  const pGidIdx = findSkuColIndex_(headers, ["Product GID", "ProductGID", "product_gid"]);
  const vGidIdx = findSkuColIndex_(headers, ["Variant GID", "VariantGID", "variant_gid"]);
  
  let statusIdx = findSkuColIndex_(headers, ["Update Status", "Status", "Log"]);
  if (statusIdx === -1) {
    statusIdx = headers.length; // เพิ่มต่อท้าย
    sheet.getRange(1, statusIdx + 1).setValue("Update Status").setFontWeight("bold");
  }

  const finalPGidIdx = pGidIdx !== -1 ? pGidIdx : 4;
  const finalVGidIdx = vGidIdx !== -1 ? vGidIdx : 5;

  Logger.log(`Found columns -> Product GID: Col ${finalPGidIdx + 1}, Variant GID: Col ${finalVGidIdx + 1}`);

  const productGroups = {};
  const statusUpdates = new Array(lastRow - 1).fill("");
  let totalValidRows = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const webSku = webSkuIdx !== -1 && row[webSkuIdx] != null ? String(row[webSkuIdx]).trim() : "";
    const winSku = winSkuIdx !== -1 && row[winSkuIdx] != null ? String(row[winSkuIdx]).trim() : "";
    const checkUpdate = checkUpdateIdx !== -1 && row[checkUpdateIdx] != null ? String(row[checkUpdateIdx]).trim().toUpperCase() : "";
    
    const pGid = finalPGidIdx !== -1 && row[finalPGidIdx] != null ? String(row[finalPGidIdx]).trim() : "";
    const vGid = finalVGidIdx !== -1 && row[finalVGidIdx] != null ? String(row[finalVGidIdx]).trim() : "";

    if (!webSku || !winSku || checkUpdate !== "FALSE") {
      statusUpdates[i - 1] = "⏭️ ข้าม (ไม่เข้าเงื่อนไข)";
      continue;
    }

    if (!pGid.startsWith("gid://shopify/Product/") || !vGid.startsWith("gid://shopify/ProductVariant/")) {
      statusUpdates[i - 1] = "❌ ข้อมูล GID ไม่ถูกต้อง";
      continue;
    }

    if (!productGroups[pGid]) {
      productGroups[pGid] = [];
    }

    productGroups[pGid].push({
      rowIndex: i,
      variantId: vGid,
      newSku: winSku // เอา winSku ส่งไปอัปเดตเป็น variant sku ใหม่
    });

    totalValidRows++;
  }

  const productIds = Object.keys(productGroups);
  if (productIds.length === 0) {
    const noValidMsg = "⚠️ ไม่พบแถวที่มีข้อมูล GID และ SKU ที่ถูกต้องสำหรับอัปเดต";
    Logger.log(noValidMsg);
    writeStatusToSheet_(sheet, statusIdx, statusUpdates);
    showAlert_(noValidMsg);
    writeSkuRunLogToSheet_(sheet.getName(), 0, 0, 0, noValidMsg);
    return;
  }

  Logger.log(`📊 พบรายการ SKU ที่ถูกต้องสำหรับอัปเดต: ${totalValidRows} รายการ (${productIds.length} สินค้า)`);

  SpreadsheetApp.getActiveSpreadsheet().toast(
    `กำลังเตรียมอัปเดต SKU ทั้งหมด ${totalValidRows} ตัวเลือก (${productIds.length} สินค้า)...`,
    "📦 Shopify SKU Updater",
    5
  );

  let successCount = 0;
  let failCount = 0;

  for (let p = 0; p < productIds.length; p++) {
    const pGid = productIds[p];
    const items = productGroups[pGid];

    for (let b = 0; b < items.length; b += SHOPIFY_SKU_CONFIG.BATCH_SIZE) {
      const batchItems = items.slice(b, b + SHOPIFY_SKU_CONFIG.BATCH_SIZE);
      
      const variantsInput = batchItems.map(item => ({
        id: item.variantId,
        inventoryItem: {
          sku: item.newSku
        }
      }));

      const mutation = `
        mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants {
              id
              sku
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const variables = {
        productId: pGid,
        variants: variantsInput
      };

      const res = callSkuGraphQL_(mutation, variables);

      if (res && res.data && res.data.productVariantsBulkUpdate) {
        const errors = res.data.productVariantsBulkUpdate.userErrors || [];
        if (errors.length > 0) {
          const errMsg = errors.map(e => e.message).join(", ");
          batchItems.forEach(item => {
            statusUpdates[item.rowIndex - 1] = `❌ ข้อผิดพลาด: ${errMsg}`;
            failCount++;
          });
        } else {
          const nowStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");
          batchItems.forEach(item => {
            statusUpdates[item.rowIndex - 1] = `✅ อัปเดตสำเร็จ (${nowStr})`;
            successCount++;
          });
        }
      } else {
        const errText = res && res.errors ? JSON.stringify(res.errors) : "เกิดข้อผิดพลาดในการเชื่อมต่อ API";
        batchItems.forEach(item => {
          statusUpdates[item.rowIndex - 1] = `❌ API Error: ${errText.substring(0, 100)}`;
          failCount++;
        });
      }

      Utilities.sleep(150);
    }

    if ((p + 1) % 10 === 0 || p === productIds.length - 1) {
      SpreadsheetApp.getActiveSpreadsheet().toast(
        `ประมวลผลแล้ว ${p + 1}/${productIds.length} สินค้า (สำเร็จ: ${successCount}, ล้มเหลว: ${failCount})`,
        "📦 Shopify SKU Updater",
        3
      );
    }
  }

  writeStatusToSheet_(sheet, statusIdx, statusUpdates);

  const summaryMsg = `🎉 อัปเดต Variant SKU เสร็จสิ้น!\n\n` +
    `• สำเร็จ: ${successCount} รายการ\n` +
    `• ล้มเหลว: ${failCount} รายการ\n` +
    `• ข้าม/ไม่พร้อม: ${lastRow - 1 - totalValidRows} รายการ\n\n` +
    `สามารถดูสถานะการอัปเดตย้อนหลังได้ที่คอลัมน์ '${headers[statusIdx] || "Update Status"}'`;

  showAlert_(summaryMsg);
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================
function writeStatusToSheet_(sheet, statusColIdx, statusUpdates) {
  if (!statusUpdates || statusUpdates.length === 0) return;
  const outputValues = statusUpdates.map(val => [val]);
  sheet.getRange(2, statusColIdx + 1, outputValues.length, 1).setValues(outputValues);
}

function findSkuColIndex_(headers, candidates) {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].toLowerCase();
    for (let c = 0; c < candidates.length; c++) {
      if (h === candidates[c].toLowerCase()) return i;
    }
  }
  return -1;
}

function getSkuAccessToken_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty(SHOPIFY_SKU_CONFIG.PROP_ACCESS_TOKEN);
  const expiry = Number(props.getProperty(SHOPIFY_SKU_CONFIG.PROP_TOKEN_EXPIRY) || 0);

  if (token && Date.now() < expiry - 300000) return token;

  const res = UrlFetchApp.fetch("https://" + SHOPIFY_SKU_CONFIG.SHOP + "/admin/oauth/access_token", {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: "grant_type=client_credentials&client_id=" + encodeURIComponent(SHOPIFY_SKU_CONFIG.CLIENT_ID) + "&client_secret=" + encodeURIComponent(SHOPIFY_SKU_CONFIG.CLIENT_SECRET),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error("Token response is invalid JSON. HTTP " + code + ": " + text);
  }
  if (!data.access_token) throw new Error("Failed to get access token. HTTP " + code + ": " + text);

  const newExpiry = Date.now() + ((Number(data.expires_in) || 3600) * 1000);
  props.setProperty(SHOPIFY_SKU_CONFIG.PROP_ACCESS_TOKEN, data.access_token);
  props.setProperty(SHOPIFY_SKU_CONFIG.PROP_TOKEN_EXPIRY, String(newExpiry));
  return data.access_token;
}

function callSkuGraphQL_(queryOrPayload, variables) {
  let payload;
  if (typeof queryOrPayload === "string") {
    payload = { query: queryOrPayload, variables: variables || {} };
  } else if (queryOrPayload && typeof queryOrPayload === "object") {
    payload = queryOrPayload;
  } else {
    throw new Error("Invalid GraphQL argument");
  }

  let maxRetries = 5;
  let waitMs = 2000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const accessToken = getSkuAccessToken_();
    const options = {
      method: "post",
      contentType: "application/json",
      headers: { "X-Shopify-Access-Token": accessToken },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    const res = UrlFetchApp.fetch("https://" + SHOPIFY_SKU_CONFIG.SHOP + "/admin/api/2025-01/graphql.json", options);
    const code = res.getResponseCode();

    if (code === 401) {
      PropertiesService.getScriptProperties().deleteProperty(SHOPIFY_SKU_CONFIG.PROP_ACCESS_TOKEN);
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

function writeSkuRunLogToSheet_(targetSheetName, totalItems, successCount, failedCount, statusMsg) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let logSheet = ss.getSheetByName(SHOPIFY_SKU_CONFIG.LOG_SHEET_NAME);
    if (!logSheet) {
      logSheet = ss.insertSheet(SHOPIFY_SKU_CONFIG.LOG_SHEET_NAME);
      const headers = ["Timestamp", "Target Sheet", "Total Items", "Success", "Failed / Skipped", "Status Message"];
      logSheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
      logSheet.setFrozenRows(1);
    }
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT+7", "yyyy-MM-dd HH:mm:ss");
    logSheet.appendRow([timestamp, targetSheetName, totalItems, successCount, failedCount, statusMsg || "Completed"]);
    Logger.log(`📝 บันทึก Log ลงใน Sheet "${SHOPIFY_SKU_CONFIG.LOG_SHEET_NAME}" เรียบร้อยแล้ว`);
  } catch (e) {
    Logger.log("⚠️ Could not write log: " + e);
  }
}

// Fallback alias for backward compatibility
function callGraphQL_(queryOrPayload, variables) {
  return callSkuGraphQL_(queryOrPayload, variables);
}
