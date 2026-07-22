// ============================================================
// CONFIG & CREDENTIALS (Scoped object to prevent clashes with รหัส.gs)
// ============================================================
var SHOPIFY_PRICE_CONFIG = {
  SHOP: "sevenfive-4062.myshopify.com",
  CLIENT_ID: "xxxxxxxxxxxxxxxxxxx",
  CLIENT_SECRET: "xxxxxxxxxxxxxxxxxxx",
  SHEET_WITH_DISCOUNT: "update_with_discount",
  SHEET_NO_DISCOUNT: "update_no_discount",
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
  ui.createMenu('📦 Shopify Tools')
    .addItem('🚀 1. อัปเดตแบบเร็วที่สุด (Bulk Mutation - รวดเดียวเสร็จใน 5 วินาที)', 'updateAllPricesBulkMutation')
    .addSeparator()
    .addItem('2. อัปเดตแบบ Direct Batch (ทั้ง 2 Sheet)', 'updateAllPricesToShopify')
    .addItem('3. อัปเดตราคาสินค้าเฉพาะ Sheet: update_with_discount', 'updateWithDiscountPrices')
    .addItem('4. อัปเดตราคาสินค้าเฉพาะ Sheet: update_no_discount', 'updateNoDiscountPrices')
    .addSeparator()
    .addItem('5. Export Products to Sheet', 'exportProductsToSheet')
    .addItem('6. แยกราคาอะไหล่ (Split Prices)', 'splitPriceSparepart')
    .addToUi();
}

// ============================================================
// ULTRA-FAST BULK MUTATION METHOD (Shopify Bulk Operation API)
// ============================================================

/**
 * อัปเดตราคาสินค้าทั้งหมด (24,000+ รายการ) ขึ้น Shopify ด้วยวิธี Bulk Operation API
 * แปลงข้อมูลใน Sheet เป็น JSONL และส่งให้ Shopify ประมวลผลแบบ Parallel บน Cloud
 * ทำงานเสร็จใน Apps Script ภายในไม่ถึง 5 วินาที!
 */
function updateAllPricesBulkMutation() {
  Logger.log("=== เริ่มต้นอัปเดตราคาแบบ Bulk Operation API (ความเร็วสูงสุด) ===");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  const jsonlLines = [];
  let totalWithCount = 0;
  let totalNoCount = 0;
  
  // 1. อ่านข้อมูลจาก update_with_discount
  const sheetWith = ss.getSheetByName(SHOPIFY_PRICE_CONFIG.SHEET_WITH_DISCOUNT);
  if (sheetWith && sheetWith.getLastRow() >= 2) {
    const dataWith = sheetWith.getRange(1, 1, sheetWith.getLastRow(), sheetWith.getLastColumn()).getValues();
    const headers = dataWith[0].map(h => String(h).trim());
    const rows = dataWith.slice(1);
    
    const pIdx = findColIndex_(headers, ["Product GID", "ProductGID", "product_gid"]);
    const vIdx = findColIndex_(headers, ["Variant GID", "VariantGID", "variant_gid"]);
    const priceWebIdx = findColIndex_(headers, ["Price Web", "Price", "price", "ราคา"]);
    const comparePriceIdx = findColIndex_(headers, ["Compare-at price", "Compare At Price", "CompareAtPrice", "compare_at_price"]);
    
    rows.forEach(row => {
      const pGid = String((pIdx !== -1 ? row[pIdx] : row[4]) || "").trim();
      const vGid = String((vIdx !== -1 ? row[vIdx] : row[5]) || "").trim();
      
      if (!pGid || pGid.indexOf("gid://shopify/Product/") === -1 ||
          !vGid || vGid.indexOf("gid://shopify/ProductVariant/") === -1) return;
          
      const pNum = parseFloat(priceWebIdx !== -1 ? row[priceWebIdx] : row[3]);
      const cNum = parseFloat(comparePriceIdx !== -1 ? row[comparePriceIdx] : row[2]);
      
      if (!isNaN(pNum) && pNum >= 0) {
        const itemObj = { id: vGid, price: pNum.toFixed(2) };
        if (!isNaN(cNum) && cNum > 0) {
          itemObj.compareAtPrice = cNum.toFixed(2);
        } else {
          itemObj.compareAtPrice = null;
        }
        jsonlLines.push(JSON.stringify({ productId: pGid, variants: [itemObj] }));
        totalWithCount++;
      }
    });
  }
  
  // 2. อ่านข้อมูลจาก update_no_discount
  const sheetNo = ss.getSheetByName(SHOPIFY_PRICE_CONFIG.SHEET_NO_DISCOUNT);
  if (sheetNo && sheetNo.getLastRow() >= 2) {
    const dataNo = sheetNo.getRange(1, 1, sheetNo.getLastRow(), sheetNo.getLastColumn()).getValues();
    const headers = dataNo[0].map(h => String(h).trim());
    const rows = dataNo.slice(1);
    
    const pIdx = findColIndex_(headers, ["Product GID", "ProductGID", "product_gid"]);
    const vIdx = findColIndex_(headers, ["Variant GID", "VariantGID", "variant_gid"]);
    const priceWebIdx = findColIndex_(headers, ["Price Web", "Price", "price", "ราคา"]);
    
    rows.forEach(row => {
      const pGid = String((pIdx !== -1 ? row[pIdx] : row[3]) || "").trim();
      const vGid = String((vIdx !== -1 ? row[vIdx] : row[4]) || "").trim();
      
      if (!pGid || pGid.indexOf("gid://shopify/Product/") === -1 ||
          !vGid || vGid.indexOf("gid://shopify/ProductVariant/") === -1) return;
          
      const pNum = parseFloat(priceWebIdx !== -1 ? row[priceWebIdx] : row[2]);
      if (!isNaN(pNum) && pNum >= 0) {
        jsonlLines.push(JSON.stringify({
          productId: pGid,
          variants: [{ id: vGid, price: pNum.toFixed(2), compareAtPrice: null }]
        }));
        totalNoCount++;
      }
    });
  }
  
  const totalItems = jsonlLines.length;
  if (totalItems === 0) {
    const emptyMsg = "⚠️ ไม่พบรายการราคาที่สมบูรณ์ใน Sheet ปลายทาง";
    Logger.log(emptyMsg);
    writeRunLogToSheet_("Bulk Mutation (All)", 0, 0, 0, emptyMsg);
    return;
  }
  
  Logger.log(`📊 รวมข้อมูล JSONL พร้อมส่ง: ${totalItems} รายการ (with_discount: ${totalWithCount}, no_discount: ${totalNoCount})`);
  
  // 3. ขอ Staged Upload Target จาก Shopify
  const stageMutation = `mutation {
    stagedUploadsCreate(input: [{
      resource: BULK_MUTATION_VARIABLES,
      filename: "price_bulk.jsonl",
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
    writeRunLogToSheet_("Bulk Mutation (All)", totalItems, 0, totalItems, errStage);
    return;
  }
  
  const target = stageRes.data.stagedUploadsCreate.stagedTargets[0];
  const uploadUrl = target.url;
  const resourceUrl = target.resourceUrl;
  
  // 4. Upload JSONL Payload ขึ้น Shopify Staged Target
  const jsonlContent = jsonlLines.join("\n") + "\n";
  Logger.log("📤 กำลังอัปโหลดไฟล์ JSONL ขนาด " + Math.round(jsonlContent.length / 1024) + " KB ขึ้น Shopify...");
  
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
    writeRunLogToSheet_("Bulk Mutation (All)", totalItems, 0, totalItems, errPut);
    return;
  }
  
  Logger.log("✅ Upload JSONL สำเร็จ! กำลังสั่ง Shopify เริ่มทำงานในพื้นหลัง...");
  
  // 5. สั่ง Shopify รัน bulkOperationRunMutation
  const runMutation = `mutation bulkRun($stagedUploadPath: String!) {
    bulkOperationRunMutation(
      mutation: "mutation variantPriceUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id price compareAtPrice } userErrors { field message } } }",
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
      const errRun = "❌ Bulk Operation เกิดข้อผิดพลาด: " + JSON.stringify(userErrors);
      Logger.log(errRun);
      writeRunLogToSheet_("Bulk Mutation (All)", totalItems, 0, totalItems, errRun);
    } else if (bulkOp) {
      const successMsg = `🚀 สั่งคำสั่ง Bulk Operation สำเร็จ! (ID: ${bulkOp.id}, Status: ${bulkOp.status}) ทั้งหมด ${totalItems} รายการกำลังอัปเดตบน Shopify Cloud`;
      Logger.log(successMsg);
      writeRunLogToSheet_("Bulk Mutation (All)", totalItems, totalItems, 0, successMsg);
    }
  } else {
    const errRunFail = "❌ ไม่สามารถเริ่ม Bulk Operation ได้";
    Logger.log(errRunFail);
    writeRunLogToSheet_("Bulk Mutation (All)", totalItems, 0, totalItems, errRunFail);
  }
}

// ============================================================
// DIRECT BATCH METHOD (GraphQL Alias Batching)
// ============================================================

/**
 * อัปเดตราคาสินค้าขึ้น Shopify สำหรับทั้ง 2 Sheet (update_with_discount และ update_no_discount)
 */
function updateAllPricesToShopify() {
  Logger.log("=== เริ่มต้นกระบวนการอัปเดตราคาสินค้าขึ้น Shopify ===");
  
  const resWith = processPriceUpdateForSheet_(SHOPIFY_PRICE_CONFIG.SHEET_WITH_DISCOUNT, true);
  const resNo = processPriceUpdateForSheet_(SHOPIFY_PRICE_CONFIG.SHEET_NO_DISCOUNT, false);
  
  const msg = `✅ สรุปการอัปเดตราคาสินค้าขึ้น Shopify:\n\n` +
    `• ${SHOPIFY_PRICE_CONFIG.SHEET_WITH_DISCOUNT}: สำเร็จ ${resWith.success} รายการ | ล้มเหลว/ข้าม ${resWith.failed} รายการ\n` +
    `• ${SHOPIFY_PRICE_CONFIG.SHEET_NO_DISCOUNT}: สำเร็จ ${resNo.success} รายการ | ล้มเหลว/ข้าม ${resNo.failed} รายการ`;
    
  Logger.log(msg);
}

/**
 * อัปเดตราคาเฉพาะ Sheet: update_with_discount
 */
function updateWithDiscountPrices() {
  Logger.log(`=== อัปเดตราคาสินค้าจาก ${SHOPIFY_PRICE_CONFIG.SHEET_WITH_DISCOUNT} ===`);
  const res = processPriceUpdateForSheet_(SHOPIFY_PRICE_CONFIG.SHEET_WITH_DISCOUNT, true);
  Logger.log(`✅ อัปเดต ${SHOPIFY_PRICE_CONFIG.SHEET_WITH_DISCOUNT} สำเร็จ: ${res.success} รายการ | ล้มเหลว/ข้าม: ${res.failed} รายการ`);
}

/**
 * อัปเดตราคาเฉพาะ Sheet: update_no_discount
 */
function updateNoDiscountPrices() {
  Logger.log(`=== อัปเดตราคาสินค้าจาก ${SHOPIFY_PRICE_CONFIG.SHEET_NO_DISCOUNT} ===`);
  const res = processPriceUpdateForSheet_(SHOPIFY_PRICE_CONFIG.SHEET_NO_DISCOUNT, false);
  Logger.log(`✅ อัปเดต ${SHOPIFY_PRICE_CONFIG.SHEET_NO_DISCOUNT} สำเร็จ: ${res.success} รายการ | ล้มเหลว/ข้าม: ${res.failed} รายการ`);
}

// ============================================================
// CORE PROCESSING LOGIC (Direct Batch)
// ============================================================

/**
 * ประมวลผลและอัปเดตราคาสำหรับ Sheet ที่กำหนด พร้อมบันทึกลง Sheet 'Log run script'
 */
function processPriceUpdateForSheet_(sheetName, isWithDiscount) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  
  if (!sheet) {
    const errMsg = `❌ ไม่พบ Sheet ชื่อ "${sheetName}"`;
    Logger.log(errMsg);
    writeRunLogToSheet_(sheetName, 0, 0, 0, errMsg);
    return { success: 0, failed: 0 };
  }
  
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  
  if (lastRow < 2) {
    const warnMsg = `⚠️ ไม่พบข้อมูลใน Sheet "${sheetName}"`;
    Logger.log(warnMsg);
    writeRunLogToSheet_(sheetName, 0, 0, 0, warnMsg);
    return { success: 0, failed: 0 };
  }
  
  // อ่านข้อมูลทั้งหมดรวม Header
  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = data[0].map(h => String(h).trim());
  const rows = data.slice(1);
  
  // ค้นหาดัชนีคอลัมน์แบบยืดหยุ่น
  const productGidIdx = findColIndex_(headers, ["Product GID", "ProductGID", "product_gid"]);
  const variantGidIdx = findColIndex_(headers, ["Variant GID", "VariantGID", "variant_gid"]);
  const priceWebIdx = findColIndex_(headers, ["Price Web", "Price", "price", "ราคา"]);
  const comparePriceIdx = findColIndex_(headers, ["Compare-at price", "Compare At Price", "CompareAtPrice", "compare_at_price"]);
  
  let totalSuccess = 0;
  let totalFailed = 0;
  let skipped = 0;
  
  const pendingUpdates = [];
  
  rows.forEach((row) => {
    const pGidRaw = productGidIdx !== -1 ? row[productGidIdx] : (isWithDiscount ? row[4] : row[3]);
    const vGidRaw = variantGidIdx !== -1 ? row[variantGidIdx] : (isWithDiscount ? row[5] : row[4]);
    
    const productGid = String(pGidRaw || "").trim();
    const variantGid = String(vGidRaw || "").trim();
    
    // ตรวจสอบความถูกต้องของ Product GID และ Variant GID
    if (!productGid || productGid.indexOf("gid://shopify/Product/") === -1 ||
        !variantGid || variantGid.indexOf("gid://shopify/ProductVariant/") === -1) {
      skipped++;
      return;
    }
    
    let priceVal = null;
    let comparePriceVal = null;
    
    if (isWithDiscount) {
      // Sheet: update_with_discount
      const pRaw = priceWebIdx !== -1 ? row[priceWebIdx] : row[3];
      const cRaw = comparePriceIdx !== -1 ? row[comparePriceIdx] : row[2];
      
      const pNum = parseFloat(pRaw);
      const cNum = parseFloat(cRaw);
      
      if (!isNaN(pNum) && pNum >= 0) priceVal = pNum.toFixed(2);
      if (!isNaN(cNum) && cNum > 0) comparePriceVal = cNum.toFixed(2);
      else comparePriceVal = null;
    } else {
      // Sheet: update_no_discount
      const pRaw = priceWebIdx !== -1 ? row[priceWebIdx] : row[2];
      const pNum = parseFloat(pRaw);
      if (!isNaN(pNum) && pNum >= 0) priceVal = pNum.toFixed(2);
      comparePriceVal = null;
    }
    
    if (priceVal !== null) {
      pendingUpdates.push({
        productId: productGid,
        id: variantGid,
        price: priceVal,
        compareAtPrice: comparePriceVal
      });
    } else {
      skipped++;
    }
  });
  
  Logger.log(`📊 [${sheetName}] พบรายการที่จะอัปเดต: ${pendingUpdates.length} รายการ (ข้าม ${skipped} รายการที่ไม่มี GID หรือราคา)`);
  
  // ทยอยส่งอัปเดตเป็น Batch (batch ละ 25 รายการ)
  const batchSize = SHOPIFY_PRICE_CONFIG.BATCH_SIZE;
  for (let i = 0; i < pendingUpdates.length; i += batchSize) {
    const chunk = pendingUpdates.slice(i, i + batchSize);
    const batchRes = sendBatchVariantPriceUpdates_(chunk);
    totalSuccess += batchRes.success;
    totalFailed += batchRes.failed;
    
    Logger.log(`  [${sheetName}] ประมวลผลแล้ว ${Math.min(i + batchSize, pendingUpdates.length)}/${pendingUpdates.length} (สำเร็จ: ${totalSuccess}, ล้มเหลว: ${totalFailed})`);
    
    if (i + batchSize < pendingUpdates.length) {
      Utilities.sleep(300);
    }
  }
  
  totalFailed += skipped;
  const statusMsg = `อัปเดตสำเร็จ ${totalSuccess}/${pendingUpdates.length} รายการ (ข้าม/ล้มเหลว ${totalFailed} รายการ)`;
  
  // บันทึก Log ลง Sheet "Log run script"
  writeRunLogToSheet_(sheetName, rows.length, totalSuccess, totalFailed, statusMsg);
  
  return { success: totalSuccess, failed: totalFailed };
}

// ============================================================
// HELPER: WRITE RUN LOG TO SHEET "Log run script"
// ============================================================

/**
 * บันทึกประวัติการรันลงใน Sheet "Log run script"
 */
function writeRunLogToSheet_(sheetName, totalItems, successCount, failedCount, statusMsg) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let logSheet = ss.getSheetByName(SHOPIFY_PRICE_CONFIG.LOG_SHEET_NAME);
    
    // ถ้ายังไม่มี Sheet "Log run script" ให้สร้างใหม่และใส่ Header
    if (!logSheet) {
      logSheet = ss.insertSheet(SHOPIFY_PRICE_CONFIG.LOG_SHEET_NAME);
      const headers = ["Timestamp", "Target Sheet", "Total Items", "Success", "Failed / Skipped", "Status Message"];
      logSheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
      logSheet.setFrozenRows(1);
    }
    
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT+7", "yyyy-MM-dd HH:mm:ss");
    logSheet.appendRow([
      timestamp,
      sheetName,
      totalItems,
      successCount,
      failedCount,
      statusMsg || "Completed"
    ]);
    
    Logger.log(`📝 บันทึก Log ลงใน Sheet "${SHOPIFY_PRICE_CONFIG.LOG_SHEET_NAME}" เรียบร้อยแล้ว`);
  } catch (e) {
    Logger.log("⚠️ เกิดข้อผิดพลาดในการบันทึก Log ลง Sheet: " + e);
  }
}

// ============================================================
// HELPER: Send Batch GraphQL Mutations (productVariantsBulkUpdate)
// ============================================================

function sendBatchVariantPriceUpdates_(variantUpdates) {
  if (!variantUpdates || variantUpdates.length === 0) return { success: 0, failed: 0 };
  
  const mutationLines = variantUpdates.map((item, idx) => {
    let comparePart = (item.compareAtPrice !== null && item.compareAtPrice !== undefined && item.compareAtPrice !== "") 
      ? `, compareAtPrice: "${item.compareAtPrice}"` 
      : `, compareAtPrice: null`;
      
    return `v${idx}: productVariantsBulkUpdate(productId: "${item.productId}", variants: [{ id: "${item.id}", price: "${item.price}"${comparePart} }]) { productVariants { id price compareAtPrice } userErrors { field message } }`;
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
      } else if (resultObj && resultObj.productVariants && resultObj.productVariants.length > 0) {
        success++;
      } else {
        failed++;
      }
    });
  } else {
    failed += variantUpdates.length;
  }
  
  return { success, failed };
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
  const token  = props.getProperty(SHOPIFY_PRICE_CONFIG.PROP_ACCESS_TOKEN);
  const expiry = Number(props.getProperty(SHOPIFY_PRICE_CONFIG.PROP_TOKEN_EXPIRY) || 0);

  if (token && Date.now() < expiry - 300000) return token;

  const res = UrlFetchApp.fetch("https://" + SHOPIFY_PRICE_CONFIG.SHOP + "/admin/oauth/access_token", {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: "grant_type=client_credentials&client_id=" + encodeURIComponent(SHOPIFY_PRICE_CONFIG.CLIENT_ID) + "&client_secret=" + encodeURIComponent(SHOPIFY_PRICE_CONFIG.CLIENT_SECRET),
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
  props.setProperty(SHOPIFY_PRICE_CONFIG.PROP_ACCESS_TOKEN, data.access_token);
  props.setProperty(SHOPIFY_PRICE_CONFIG.PROP_TOKEN_EXPIRY, String(newExpiry));
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
    
    const res = UrlFetchApp.fetch("https://" + SHOPIFY_PRICE_CONFIG.SHOP + "/admin/api/2025-01/graphql.json", options);
    const code = res.getResponseCode();
    
    if (code === 401) {
      PropertiesService.getScriptProperties().deleteProperty(SHOPIFY_PRICE_CONFIG.PROP_ACCESS_TOKEN);
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
