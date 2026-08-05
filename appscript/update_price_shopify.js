// ============================================================
// SHOPIFY BULK PRICE UPDATE
// Google Apps Script
//
// เงื่อนไข:
// - update_with_discount อ่าน A:J (10 คอลัมน์)
//   - D = Price (Special price), C = Compare At Price
//   - อัปเดตเมื่อ check Compare-at price update หรือ check price update = FALSE
// - update_no_discount อ่าน A:G (7 คอลัมน์)
//   - C = ราคาสินค้า (Price)
//   - อัปเดตเมื่อ check price update = FALSE
// - ไม่เขียน Log ลงชีต
// ============================================================


// ============================================================
// CONFIG
// ============================================================

var SHOPIFY_PRICE_CONFIG = {
  SHOP: "sevenfive-4062.myshopify.com",
  CLIENT_ID: "696e1e9162c702cc07c2f94a1beacf8a",
  CLIENT_SECRET: "YOUR_CLIENT_SECRET",

  SPREADSHEET_ID:
    "1FPEsVsZbIPmwEFOgnPJ8W9t7yKIS4NX5lY83gqskhcQ",

>>>>>>> origin/main
  SHEET_WITH_DISCOUNT: "update_with_discount",
  SHEET_NO_DISCOUNT: "update_no_discount",

  API_VERSION: "2026-07",

  PROP_ACCESS_TOKEN: "SHOPIFY_PRICE_ACCESS_TOKEN",
  PROP_TOKEN_EXPIRY: "SHOPIFY_PRICE_TOKEN_EXPIRY",
  PROP_BULK_OPERATION_ID: "SHOPIFY_PRICE_BULK_OPERATION_ID"
};


// ============================================================
// MAIN FUNCTION
// ============================================================

function updateAllPricesBulkMutation() {
<<<<<<< HEAD
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
    
    const pIdx = findPriceColIndex_(headers, ["Product GID", "ProductGID", "product_gid"]);
    const vIdx = findPriceColIndex_(headers, ["Variant GID", "VariantGID", "variant_gid"]);
    const priceWebIdx = findPriceColIndex_(headers, ["price website", "Price Web", "Price", "price", "ราคา"]);
    const comparePriceIdx = findPriceColIndex_(headers, ["Compare-at price", "Compare At Price", "CompareAtPrice", "compare_at_price"]);
    
    rows.forEach(row => {
      const pGid = String((pIdx !== -1 ? row[pIdx] : row[8]) || "").trim();
      const vGid = String((vIdx !== -1 ? row[vIdx] : row[9]) || "").trim();
      
      if (!pGid || pGid.indexOf("gid://shopify/Product/") === -1 ||
          !vGid || vGid.indexOf("gid://shopify/ProductVariant/") === -1) return;
          
      const pNum = parseFloat(priceWebIdx !== -1 ? row[priceWebIdx] : row[3]);
      const cNum = parseFloat(comparePriceIdx !== -1 ? row[comparePriceIdx] : row[2]);
      
      if (!isNaN(pNum) && pNum >= 0) {
        const itemObj = { id: vGid, price: pNum.toFixed(2) };
        if (!isNaN(cNum) && cNum > 0) itemObj.compareAtPrice = cNum.toFixed(2);
        else itemObj.compareAtPrice = null;
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
    
    const pIdx = findPriceColIndex_(headers, ["Product GID", "ProductGID", "product_gid"]);
    const vIdx = findPriceColIndex_(headers, ["Variant GID", "VariantGID", "variant_gid"]);
    const priceWebIdx = findPriceColIndex_(headers, ["price website", "Price Web", "Price", "price", "ราคา"]);
    
    rows.forEach(row => {
      const pGid = String((pIdx !== -1 ? row[pIdx] : row[5]) || "").trim();
      const vGid = String((vIdx !== -1 ? row[vIdx] : row[6]) || "").trim();
      
      if (!pGid || pGid.indexOf("gid://shopify/Product/") === -1 ||
          !vGid || vGid.indexOf("gid://shopify/ProductVariant/") === -1) return;
          
      const pNum = parseFloat(priceWebIdx !== -1 ? row[priceWebIdx] : row[3]);
      if (!isNaN(pNum) && pNum >= 0) {
        jsonlLines.push(JSON.stringify({
          productId: pGid,
          variants: [{ id: vGid, price: pNum.toFixed(2), compareAtPrice: null }]
        }));
        totalNoCount++;
=======
  var startedAt = Date.now();

  console.log("================================================");
  console.log("🚀 เริ่มต้นอัปเดตราคา Shopify");
  console.log("================================================");

  try {
    var spreadsheet = openPriceSpreadsheet_();

    var jsonlLines = [];

    var totalWithDiscount = 0;
    var totalNoDiscount = 0;

    var skippedUpdateTrue = 0;
    var skippedInvalidGid = 0;
    var skippedInvalidPrice = 0;


    // ========================================================
    // 1. อ่าน update_with_discount
    // ช่วงข้อมูล A:J (10 คอลัมน์)
    // ========================================================

    console.time("อ่าน update_with_discount");

    var sheetWith = spreadsheet.getSheetByName(
      SHOPIFY_PRICE_CONFIG.SHEET_WITH_DISCOUNT
    );

    if (!sheetWith) {
      console.warn(
        "⚠️ ไม่พบชีต " +
        SHOPIFY_PRICE_CONFIG.SHEET_WITH_DISCOUNT
      );
    } else {
      var lastRowWith = sheetWith.getLastRow();

      if (lastRowWith >= 2) {
        /*
         * อ่านครอบคลุม A:J (10 คอลัมน์)
         *
         * Col A (0): GoodCode
         * Col B (1): (Unused/Compare-at price)
         * Col C (2): Compare At Price
         * Col D (3): Price (Discounted / Special price)
         * Col E (4): Compare At Price (website)
         * Col F (5): Price (website)
         * Col G (6): check Compare-at price update
         * Col H (7): check price update
         * Col I (8): Product GID
         * Col J (9): Variant GID
         */
        var dataWith = sheetWith
          .getRange(1, 1, lastRowWith, 10)
          .getValues();

        var headersWith = dataWith[0].map(function (header) {
          return String(header || "").trim();
        });

        var rowsWith = dataWith.slice(1);

        var comparePriceIndex = findColumnIndex_(
          headersWith,
          [
            "Compare At Price",
            "Compare-at price",
            "CompareAtPrice",
            "compare_at_price"
          ],
          2
        );

        var specialPriceIndex = findColumnIndex_(
          headersWith,
          [
            "Price",
            "special_price",
            "special price",
            "Price Web",
            "price",
            "ราคาพิเศษ"
          ],
          3
        );

        var checkCompareUpdateIndex = findColumnIndex_(
          headersWith,
          [
            "check Compare-at price update",
            "check Compare at price update",
            "check_compare_at_price_update",
            "check compare-at price update"
          ],
          6
        );

        var checkPriceUpdateIndex = findColumnIndex_(
          headersWith,
          [
            "check price update",
            "check_price_update"
          ],
          7
        );

        var productGidIndex = findColumnIndex_(
          headersWith,
          [
            "Product GID",
            "ProductGID",
            "product_gid"
          ],
          8
        );

        var variantGidIndex = findColumnIndex_(
          headersWith,
          [
            "Variant GID",
            "VariantGID",
            "variant_gid"
          ],
          9
        );

        console.log(
          "📥 update_with_discount มีข้อมูล " +
          rowsWith.length +
          " แถว"
        );

        for (var i = 0; i < rowsWith.length; i++) {
          var row = rowsWith[i];

          /*
           * เช็กเงื่อนไข: อัปเดตเมื่อ check Compare-at price update = FALSE หรือ check price update = FALSE
           */
          var isCompareFalse = (checkCompareUpdateIndex !== -1) && isUpdateFalse_(row[checkCompareUpdateIndex]);
          var isPriceFalse = (checkPriceUpdateIndex !== -1) && isUpdateFalse_(row[checkPriceUpdateIndex]);

          if (!isCompareFalse && !isPriceFalse) {
            skippedUpdateTrue++;
            continue;
          }

          var productGid = String(
            row[productGidIndex] || ""
          ).trim();

          var variantGid = String(
            row[variantGidIndex] || ""
          ).trim();

          if (
            !isValidProductGid_(productGid) ||
            !isValidVariantGid_(variantGid)
          ) {
            skippedInvalidGid++;
            continue;
          }

          // Column D (index 3): Price (นำไปเป็น price ใน Shopify)
          var specialPriceVal = parsePrice_(
            row[specialPriceIndex]
          );

          // Column C (index 2): Compare At Price (นำไปเป็น compareAtPrice ใน Shopify)
          var compareAtPriceVal = parsePrice_(
            row[comparePriceIndex]
          );

          if (
            specialPriceVal === null ||
            specialPriceVal < 0
          ) {
            skippedInvalidPrice++;
            continue;
          }

          var variantInput = {
            id: variantGid,
            price: specialPriceVal.toFixed(2),
            compareAtPrice:
              compareAtPriceVal !== null &&
              compareAtPriceVal > 0
                ? compareAtPriceVal.toFixed(2)
                : null
          };

          jsonlLines.push(
            JSON.stringify({
              productId: productGid,
              variants: [variantInput]
            })
          );

          totalWithDiscount++;
        }
      } else {
        console.log(
          "ℹ️ update_with_discount ไม่มีข้อมูล"
        );
      }
    }

    console.timeEnd("อ่าน update_with_discount");

    console.log(
      "✅ update_with_discount พร้อมอัปเดต " +
      totalWithDiscount +
      " รายการ"
    );


    // ========================================================
    // 2. อ่าน update_no_discount
    // ช่วงข้อมูล A:G (7 คอลัมน์)
    // ========================================================

    console.time("อ่าน update_no_discount");

    var sheetNo = spreadsheet.getSheetByName(
      SHOPIFY_PRICE_CONFIG.SHEET_NO_DISCOUNT
    );

    if (!sheetNo) {
      console.warn(
        "⚠️ ไม่พบชีต " +
        SHOPIFY_PRICE_CONFIG.SHEET_NO_DISCOUNT
      );
    } else {
      var lastRowNo = sheetNo.getLastRow();

      if (lastRowNo >= 2) {
        /*
         * อ่านครอบคลุม A:G (7 คอลัมน์)
         *
         * Col A (0): GoodID
         * Col B (1): GoodCode
         * Col C (2): ราคาสินค้า
         * Col D (3): price website
         * Col E (4): check price update
         * Col F (5): Product GID
         * Col G (6): Variant GID
         */
        var dataNo = sheetNo
          .getRange(1, 1, lastRowNo, 7)
          .getValues();

        var headersNo = dataNo[0].map(function (header) {
          return String(header || "").trim();
        });

        var rowsNo = dataNo.slice(1);

        var noPriceIndex = findColumnIndex_(
          headersNo,
          [
            "ราคาสินค้า",
            "ราคา",
            "Price",
            "price",
            "Price Web"
          ],
          2
        );

        var noCheckPriceUpdateIndex = findColumnIndex_(
          headersNo,
          [
            "check price update",
            "check_price_update",
            "check update",
            "Update",
            "update"
          ],
          4
        );

        var noProductGidIndex = findColumnIndex_(
          headersNo,
          [
            "Product GID",
            "ProductGID",
            "product_gid"
          ],
          5
        );

        var noVariantGidIndex = findColumnIndex_(
          headersNo,
          [
            "Variant GID",
            "VariantGID",
            "variant_gid"
          ],
          6
        );

        console.log(
          "📥 update_no_discount มีข้อมูล " +
          rowsNo.length +
          " แถว"
        );

        for (var j = 0; j < rowsNo.length; j++) {
          var noRow = rowsNo[j];

          /*
           * เช็กเงื่อนไข: อัปเดตเมื่อ check price update = FALSE
           */
          if (!isUpdateFalse_(noRow[noCheckPriceUpdateIndex])) {
            skippedUpdateTrue++;
            continue;
          }

          var noProductGid = String(
            noRow[noProductGidIndex] || ""
          ).trim();

          var noVariantGid = String(
            noRow[noVariantGidIndex] || ""
          ).trim();

          if (
            !isValidProductGid_(noProductGid) ||
            !isValidVariantGid_(noVariantGid)
          ) {
            skippedInvalidGid++;
            continue;
          }

          // Column C: ราคาสินค้า (นำไปเป็น price ใน Shopify)
          var noPriceVal = parsePrice_(
            noRow[noPriceIndex]
          );

          if (
            noPriceVal === null ||
            noPriceVal < 0
          ) {
            skippedInvalidPrice++;
            continue;
          }

          jsonlLines.push(
            JSON.stringify({
              productId: noProductGid,
              variants: [
                {
                  id: noVariantGid,
                  price: noPriceVal.toFixed(2),

                  /*
                   * ไม่มีส่วนลด
                   * ล้าง Compare-at price ใน Shopify
                   */
                  compareAtPrice: null
                }
              ]
            })
          );

          totalNoDiscount++;
        }
      } else {
        console.log(
          "ℹ️ update_no_discount ไม่มีข้อมูล"
        );
>>>>>>> origin/main
      }
    }
<<<<<<< HEAD
  }`;
  
  const stageRes = callPriceGraphQL_(stageMutation);
  if (!stageRes || !stageRes.data || !stageRes.data.stagedUploadsCreate) {
    const errStage = "❌ สร้าง Staged Upload ล้มเหลว";
    Logger.log(errStage);
    writeRunLogToSheet_("Bulk Mutation (All)", totalItems, 0, totalItems, errStage);
    return;
  }
  
  const target = stageRes.data.stagedUploadsCreate.stagedTargets[0];
  const uploadUrl = target.url;
  const resourceUrl = target.resourceUrl;
  const targetParams = target.parameters || [];
  
  // 4. Upload JSONL Payload ขึ้น Shopify Staged Target
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
  
  const runRes = callPriceGraphQL_(runMutation, { stagedUploadPath: resourceUrl });
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
=======
>>>>>>> origin/main

    console.timeEnd("อ่าน update_no_discount");

<<<<<<< HEAD
function updateAllPricesToShopify() {
  Logger.log("=== เริ่มต้นกระบวนการอัปเดตราคาสินค้าขึ้น Shopify ===");
  const resWith = processPriceUpdateForSheet_(SHOPIFY_PRICE_CONFIG.SHEET_WITH_DISCOUNT, true);
  const resNo = processPriceUpdateForSheet_(SHOPIFY_PRICE_CONFIG.SHEET_NO_DISCOUNT, false);
  
  const msg = `✅ สรุปการอัปเดตราคาสินค้าขึ้น Shopify:\n\n` +
    `• ${SHOPIFY_PRICE_CONFIG.SHEET_WITH_DISCOUNT}: สำเร็จ ${resWith.success} รายการ | ล้มเหลว/ข้าม ${resWith.failed} รายการ\n` +
    `• ${SHOPIFY_PRICE_CONFIG.SHEET_NO_DISCOUNT}: สำเร็จ ${resNo.success} รายการ | ล้มเหลว/ข้าม ${resNo.failed} รายการ`;
  Logger.log(msg);
}

function updateWithDiscountPrices() {
  Logger.log(`=== อัปเดตราคาสินค้าจาก ${SHOPIFY_PRICE_CONFIG.SHEET_WITH_DISCOUNT} ===`);
  const res = processPriceUpdateForSheet_(SHOPIFY_PRICE_CONFIG.SHEET_WITH_DISCOUNT, true);
  Logger.log(`✅ อัปเดต ${SHOPIFY_PRICE_CONFIG.SHEET_WITH_DISCOUNT} สำเร็จ: ${res.success} รายการ | ล้มเหลว/ข้าม: ${res.failed} รายการ`);
}

function updateNoDiscountPrices() {
  Logger.log(`=== อัปเดตราคาสินค้าจาก ${SHOPIFY_PRICE_CONFIG.SHEET_NO_DISCOUNT} ===`);
  const res = processPriceUpdateForSheet_(SHOPIFY_PRICE_CONFIG.SHEET_NO_DISCOUNT, false);
  Logger.log(`✅ อัปเดต ${SHOPIFY_PRICE_CONFIG.SHEET_NO_DISCOUNT} สำเร็จ: ${res.success} รายการ | ล้มเหลว/ข้าม: ${res.failed} รายการ`);
}

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
  
  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = data[0].map(h => String(h).trim());
  const rows = data.slice(1);
  
  const productGidIdx = findPriceColIndex_(headers, ["Product GID", "ProductGID", "product_gid"]);
  const variantGidIdx = findPriceColIndex_(headers, ["Variant GID", "VariantGID", "variant_gid"]);
  const priceWebIdx = findPriceColIndex_(headers, ["price website", "Price Web", "Price", "price", "ราคา"]);
  const comparePriceIdx = findPriceColIndex_(headers, ["Compare-at price", "Compare At Price", "CompareAtPrice", "compare_at_price"]);
  
  let totalSuccess = 0;
  let totalFailed = 0;
  let skipped = 0;
  const pendingUpdates = [];
  
  rows.forEach((row) => {
    const pGidRaw = productGidIdx !== -1 ? row[productGidIdx] : (isWithDiscount ? row[8] : row[5]);
    const vGidRaw = variantGidIdx !== -1 ? row[variantGidIdx] : (isWithDiscount ? row[9] : row[6]);
    
    const productGid = String(pGidRaw || "").trim();
    const variantGid = String(vGidRaw || "").trim();
    
    if (!productGid || productGid.indexOf("gid://shopify/Product/") === -1 ||
        !variantGid || variantGid.indexOf("gid://shopify/ProductVariant/") === -1) {
      skipped++;
      return;
    }
    
    let priceVal = null;
    let comparePriceVal = null;
    
    if (isWithDiscount) {
      const pRaw = priceWebIdx !== -1 ? row[priceWebIdx] : row[3];
      const cRaw = comparePriceIdx !== -1 ? row[comparePriceIdx] : row[2];
      
      const pNum = parseFloat(pRaw);
      const cNum = parseFloat(cRaw);
      
      if (!isNaN(pNum) && pNum >= 0) priceVal = pNum.toFixed(2);
      if (!isNaN(cNum) && cNum > 0) comparePriceVal = cNum.toFixed(2);
      else comparePriceVal = null;
    } else {
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
  
  writeRunLogToSheet_(sheetName, rows.length, totalSuccess, totalFailed, statusMsg);
  return { success: totalSuccess, failed: totalFailed };
}

function writeRunLogToSheet_(sheetName, totalItems, successCount, failedCount, statusMsg) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let logSheet = ss.getSheetByName(SHOPIFY_PRICE_CONFIG.LOG_SHEET_NAME);
    
    if (!logSheet) {
      logSheet = ss.insertSheet(SHOPIFY_PRICE_CONFIG.LOG_SHEET_NAME);
      const headers = ["Timestamp", "Target Sheet", "Total Items", "Success", "Failed / Skipped", "Status Message"];
      logSheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
      logSheet.setFrozenRows(1);
=======
    console.log(
      "✅ update_no_discount พร้อมอัปเดต " +
      totalNoDiscount +
      " รายการ"
    );


    // ========================================================
    // 3. สรุปข้อมูล
    // ========================================================

    var totalItems = jsonlLines.length;

    console.log("------------------------------------------------");
    console.log("📊 สรุปข้อมูล");
    console.log(
      "มีส่วนลด              : " +
      totalWithDiscount
    );
    console.log(
      "ไม่มีส่วนลด            : " +
      totalNoDiscount
    );
    console.log(
      "ข้าม Update ไม่ใช่ FALSE: " +
      skippedUpdateTrue
    );
    console.log(
      "ข้าม GID ไม่ถูกต้อง     : " +
      skippedInvalidGid
    );
    console.log(
      "ข้ามราคาไม่ถูกต้อง      : " +
      skippedInvalidPrice
    );
    console.log(
      "รวมพร้อมส่ง Shopify     : " +
      totalItems
    );
    console.log("------------------------------------------------");

    if (totalItems === 0) {
      console.warn(
        "⚠️ ไม่พบข้อมูลที่ Update = FALSE และพร้อมอัปเดต"
      );

      return;
    }


    // ========================================================
    // 4. สร้าง JSONL
    // ========================================================

    var jsonlContent =
      jsonlLines.join("\n") + "\n";

    var jsonlBlob = Utilities.newBlob(
      jsonlContent,
      "text/jsonl",
      "price_bulk.jsonl"
    );

    var fileSizeBytes =
      jsonlBlob.getBytes().length;

    var fileSizeKb =
      Math.ceil(fileSizeBytes / 1024);

    var fileSizeMb =
      fileSizeBytes / 1024 / 1024;

    console.log(
      "📄 JSONL ขนาด " +
      fileSizeKb +
      " KB"
    );

    /*
     * Shopify Bulk JSONL จำกัด 100 MB
     */
    if (fileSizeMb > 100) {
      throw new Error(
        "ไฟล์ JSONL เกิน 100 MB: " +
        fileSizeMb.toFixed(2) +
        " MB"
      );
>>>>>>> origin/main
    }

<<<<<<< HEAD
function sendBatchVariantPriceUpdates_(variantUpdates) {
  if (!variantUpdates || variantUpdates.length === 0) return { success: 0, failed: 0 };
  
  const mutationLines = variantUpdates.map((item, idx) => {
    let comparePart = (item.compareAtPrice !== null && item.compareAtPrice !== undefined && item.compareAtPrice !== "") 
      ? `, compareAtPrice: "${item.compareAtPrice}"` 
      : `, compareAtPrice: null`;
      
    return `v${idx}: productVariantsBulkUpdate(productId: "${item.productId}", variants: [{ id: "${item.id}", price: "${item.price}"${comparePart} }]) { productVariants { id price compareAtPrice } userErrors { field message } }`;
  });
  
  const fullQuery = `mutation {\n${mutationLines.join("\n")}\n}`;
  const res = callPriceGraphQL_(fullQuery);
  
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
=======

    // ========================================================
    // 5. ขอ Staged Upload Target
    // ========================================================

    console.log(
      "⏳ ขั้นตอน 1/3: ขอ Staged Upload Target"
    );

    console.time("stagedUploadsCreate");

    var stageMutation = `
      mutation {
        stagedUploadsCreate(
          input: [
            {
              resource: BULK_MUTATION_VARIABLES
              filename: "price_bulk.jsonl"
              mimeType: "text/jsonl"
              httpMethod: POST
            }
          ]
        ) {
          stagedTargets {
            url
            resourceUrl
            parameters {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
>>>>>>> origin/main
      }
    `;

    var stageResponse = callShopifyGraphQL_(
      stageMutation,
      {}
    );

    console.timeEnd("stagedUploadsCreate");

    var stageResult =
      stageResponse &&
      stageResponse.data &&
      stageResponse.data.stagedUploadsCreate;

    if (!stageResult) {
      throw new Error(
        "Shopify ไม่ส่ง stagedUploadsCreate กลับมา"
      );
    }

    if (
      stageResult.userErrors &&
      stageResult.userErrors.length > 0
    ) {
      throw new Error(
        "stagedUploadsCreate Error: " +
        JSON.stringify(stageResult.userErrors)
      );
    }

    if (
      !stageResult.stagedTargets ||
      stageResult.stagedTargets.length === 0
    ) {
      throw new Error(
        "Shopify ไม่ส่ง Staged Upload Target กลับมา"
      );
    }

    var stagedTarget =
      stageResult.stagedTargets[0];

    console.log(
      "✅ ได้ Staged Upload Target"
    );


    // ========================================================
    // 6. Upload JSONL
    // ========================================================

    console.log(
      "⏳ ขั้นตอน 2/3: Upload JSONL"
    );

    console.time("upload JSONL");

    var uploadResult = uploadJsonlToShopify_(
      stagedTarget,
      jsonlBlob
    );

    console.timeEnd("upload JSONL");

    console.log(
      "✅ Upload JSONL สำเร็จ HTTP " +
      uploadResult.status
    );


    // ========================================================
    // 7. เริ่ม Bulk Operation
    // ========================================================

    console.log(
      "⏳ ขั้นตอน 3/3: เริ่ม Bulk Operation"
    );

    console.time("bulkOperationRunMutation");

    var bulkMutationString = `
      mutation variantPriceUpdate(
        $productId: ID!
        $variants: [ProductVariantsBulkInput!]!
      ) {
        productVariantsBulkUpdate(
          productId: $productId
          variants: $variants
        ) {
          productVariants {
            id
            price
            compareAtPrice
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    var runMutation = `
      mutation bulkRun(
        $mutation: String!
        $stagedUploadPath: String!
      ) {
        bulkOperationRunMutation(
          mutation: $mutation
          stagedUploadPath: $stagedUploadPath
        ) {
          bulkOperation {
            id
            status
            createdAt
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    var runVariables = {
      mutation: bulkMutationString,

      /*
       * ใช้ค่า key จาก staged upload parameters
       */
      stagedUploadPath:
        uploadResult.stagedUploadPath
    };

    var runResponse = callShopifyGraphQL_(
      runMutation,
      runVariables
    );

    console.timeEnd("bulkOperationRunMutation");

    var runResult =
      runResponse &&
      runResponse.data &&
      runResponse.data.bulkOperationRunMutation;

    if (!runResult) {
      throw new Error(
        "Shopify ไม่ส่ง bulkOperationRunMutation กลับมา"
      );
    }

    if (
      runResult.userErrors &&
      runResult.userErrors.length > 0
    ) {
      throw new Error(
        "Bulk Operation Error: " +
        JSON.stringify(runResult.userErrors)
      );
    }

    if (!runResult.bulkOperation) {
      throw new Error(
        "Shopify ไม่ได้สร้าง Bulk Operation"
      );
    }

    var bulkOperation =
      runResult.bulkOperation;

    PropertiesService
      .getScriptProperties()
      .setProperty(
        SHOPIFY_PRICE_CONFIG.PROP_BULK_OPERATION_ID,
        bulkOperation.id
      );

    var elapsedSeconds =
      ((Date.now() - startedAt) / 1000).toFixed(2);

    console.log("================================================");
    console.log("🚀 เริ่ม Bulk Operation สำเร็จ");
    console.log(
      "Operation ID : " +
      bulkOperation.id
    );
    console.log(
      "Status       : " +
      bulkOperation.status
    );
    console.log(
      "รายการ       : " +
      totalItems
    );
    console.log(
      "เวลาส่งงาน   : " +
      elapsedSeconds +
      " วินาที"
    );
    console.log(
      "Shopify กำลังอัปเดตราคาเบื้องหลัง"
    );
    console.log("================================================");

  } catch (error) {
    var errorElapsed =
      ((Date.now() - startedAt) / 1000).toFixed(2);

    console.error("================================================");
    console.error("❌ อัปเดตราคาล้มเหลว");
    console.error(
      error && error.stack
        ? error.stack
        : String(error)
    );
    console.error(
      "เวลาที่ใช้ก่อน Error: " +
      errorElapsed +
      " วินาที"
    );
    console.error("================================================");

    throw error;
  }
}

<<<<<<< HEAD
function findPriceColIndex_(headers, candidates) {
  for (let i = 0; i < headers.length; i++) {
    for (let j = 0; j < candidates.length; j++) {
      if (headers[i].toLowerCase() === candidates[j].toLowerCase()) return i;
=======

// ============================================================
// OPEN SPREADSHEET
// ============================================================

function openPriceSpreadsheet_() {
  try {
    return SpreadsheetApp.openById(
      SHOPIFY_PRICE_CONFIG.SPREADSHEET_ID
    );
  } catch (error) {
    console.warn(
      "⚠️ openById ไม่สำเร็จ ลองใช้ Active Spreadsheet"
    );

    var activeSpreadsheet =
      SpreadsheetApp.getActiveSpreadsheet();

    if (!activeSpreadsheet) {
      throw new Error(
        "ไม่สามารถเปิด Google Spreadsheet ได้"
      );
    }

    return activeSpreadsheet;
  }
}


// ============================================================
// UPDATE CHECK
// รองรับ:
// - Checkbox false
// - Boolean false
// - ข้อความ FALSE
// - เลข 0
// - ข้อความ 0
// ============================================================

function isUpdateFalse_(value) {
  if (value === false || value === 0) {
    return true;
  }

  var normalized = String(value)
    .trim()
    .toLowerCase();

  return (
    normalized === "false" ||
    normalized === "0"
  );
}


// ============================================================
// FIND COLUMN
// ============================================================

function findColumnIndex_(
  headers,
  possibleNames,
  fallbackIndex
) {
  var normalizedHeaders = headers.map(
    function (header) {
      return normalizeHeader_(header);
    }
  );

  for (var i = 0; i < possibleNames.length; i++) {
    var normalizedName =
      normalizeHeader_(possibleNames[i]);

    var foundIndex =
      normalizedHeaders.indexOf(normalizedName);

    if (foundIndex !== -1) {
      return foundIndex;
>>>>>>> origin/main
    }
  }

  console.warn(
    "⚠️ ไม่พบ Header: " +
    possibleNames.join(" / ") +
    " ใช้ fallback index " +
    fallbackIndex
  );

  return fallbackIndex;
}

<<<<<<< HEAD
function getPriceAccessToken_() {
  const props  = PropertiesService.getScriptProperties();
  const token  = props.getProperty(SHOPIFY_PRICE_CONFIG.PROP_ACCESS_TOKEN);
  const expiry = Number(props.getProperty(SHOPIFY_PRICE_CONFIG.PROP_TOKEN_EXPIRY) || 0);
=======

function normalizeHeader_(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}


// ============================================================
// PRICE
// ============================================================
>>>>>>> origin/main

function parsePrice_(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  if (
    typeof value === "number" &&
    isFinite(value)
  ) {
    return value;
  }

  var normalized = String(value)
    .replace(/,/g, "")
    .trim();

  if (normalized === "") {
    return null;
  }

  var parsed = Number(normalized);

  return isFinite(parsed)
    ? parsed
    : null;
}

<<<<<<< HEAD
function callPriceGraphQL_(queryOrPayload, variables) {
  let payload;
  if (typeof queryOrPayload === "string") {
    payload = { query: queryOrPayload, variables: variables || {} };
  } else if (queryOrPayload && typeof queryOrPayload === "object") {
    payload = queryOrPayload;
  } else {
    throw new Error("Invalid GraphQL query argument");
  }

  let maxRetries = 5;
  let waitMs = 2000;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const accessToken = getPriceAccessToken_();
    const options = {
=======

// ============================================================
// VALIDATE SHOPIFY GID
// ============================================================

function isValidProductGid_(value) {
  return String(value).indexOf(
    "gid://shopify/Product/"
  ) === 0;
}


function isValidVariantGid_(value) {
  return String(value).indexOf(
    "gid://shopify/ProductVariant/"
  ) === 0;
}


// ============================================================
// SHOPIFY GRAPHQL
// ============================================================

function callShopifyGraphQL_(
  query,
  variables
) {
  var accessToken =
    getShopifyAccessToken_();

  var url =
    "https://" +
    SHOPIFY_PRICE_CONFIG.SHOP +
    "/admin/api/" +
    SHOPIFY_PRICE_CONFIG.API_VERSION +
    "/graphql.json";

  var response = UrlFetchApp.fetch(
    url,
    {
>>>>>>> origin/main
      method: "post",

      contentType: "application/json",

      headers: {
        "X-Shopify-Access-Token":
          accessToken
      },

      payload: JSON.stringify({
        query: query,
        variables: variables || {}
      }),

      muteHttpExceptions: true
    }
  );

  var responseCode =
    response.getResponseCode();

  var responseText =
    response.getContentText();

  var responseData;

  try {
    responseData =
      JSON.parse(responseText);
  } catch (parseError) {
    throw new Error(
      "Shopify ตอบกลับไม่ใช่ JSON HTTP " +
      responseCode +
      ": " +
      responseText.substring(0, 500)
    );
  }

  if (
    responseCode < 200 ||
    responseCode >= 300
  ) {
    throw new Error(
      "Shopify GraphQL HTTP " +
      responseCode +
      ": " +
      responseText.substring(0, 1000)
    );
  }

  if (
    responseData.errors &&
    responseData.errors.length > 0
  ) {
    throw new Error(
      "GraphQL Error: " +
      JSON.stringify(responseData.errors)
    );
  }

  return responseData;
}


// ============================================================
// ACCESS TOKEN
// ============================================================

function getShopifyAccessToken_() {
  var properties =
    PropertiesService.getScriptProperties();

  var savedToken =
    properties.getProperty(
      SHOPIFY_PRICE_CONFIG.PROP_ACCESS_TOKEN
    );

  var savedExpiry = Number(
    properties.getProperty(
      SHOPIFY_PRICE_CONFIG.PROP_TOKEN_EXPIRY
    ) || 0
  );

  /*
   * ใช้ Token เดิมหากยังไม่หมดอายุ
   */
  if (
    savedToken &&
    savedExpiry > Date.now()
  ) {
    return savedToken;
  }

  console.log(
    "🔑 กำลังขอ Shopify Access Token ใหม่"
  );

  var tokenUrl =
    "https://" +
    SHOPIFY_PRICE_CONFIG.SHOP +
    "/admin/oauth/access_token";

  /*
   * ส่งแบบ application/x-www-form-urlencoded
   */
  var tokenResponse = UrlFetchApp.fetch(
    tokenUrl,
    {
      method: "post",

      payload: {
        grant_type: "client_credentials",
        client_id:
          SHOPIFY_PRICE_CONFIG.CLIENT_ID,
        client_secret:
          SHOPIFY_PRICE_CONFIG.CLIENT_SECRET
      },

      muteHttpExceptions: true
    }
  );

  var tokenStatus =
    tokenResponse.getResponseCode();

  var tokenText =
    tokenResponse.getContentText();

  if (
    tokenStatus < 200 ||
    tokenStatus >= 300
  ) {
    throw new Error(
      "ขอ Shopify Access Token ไม่สำเร็จ HTTP " +
      tokenStatus +
      ": " +
      tokenText.substring(0, 1000)
    );
  }

  var tokenData;

  try {
    tokenData = JSON.parse(tokenText);
  } catch (parseError) {
    throw new Error(
      "Token Response ไม่ใช่ JSON: " +
      tokenText.substring(0, 500)
    );
  }

  if (!tokenData.access_token) {
    throw new Error(
      "Shopify ไม่ส่ง access_token กลับมา: " +
      tokenText.substring(0, 500)
    );
  }

  /*
   * Shopify Client Credentials Token
   * ปกติมีอายุประมาณ 24 ชั่วโมง
   */
  var expiresInSeconds =
    Number(tokenData.expires_in || 86399);

  /*
   * ลบออก 5 นาที ป้องกัน Token หมดอายุระหว่างรัน
   */
  var expiryTimestamp =
    Date.now() +
    expiresInSeconds * 1000 -
    5 * 60 * 1000;

  properties.setProperty(
    SHOPIFY_PRICE_CONFIG.PROP_ACCESS_TOKEN,
    tokenData.access_token
  );

  properties.setProperty(
    SHOPIFY_PRICE_CONFIG.PROP_TOKEN_EXPIRY,
    String(expiryTimestamp)
  );

  console.log(
    "✅ ได้รับ Shopify Access Token ใหม่"
  );

  return tokenData.access_token;
}


// ============================================================
// UPLOAD JSONL
// ============================================================

function uploadJsonlToShopify_(
  stagedTarget,
  jsonlBlob
) {
  if (!stagedTarget || !stagedTarget.url) {
    throw new Error(
      "Staged Upload Target ไม่ถูกต้อง"
    );
  }

  var parameters =
    stagedTarget.parameters || [];

  var formPayload = {};
  var stagedUploadPath = "";

  /*
   * เพิ่ม parameters ที่ Shopify ส่งมา
   */
  for (var i = 0; i < parameters.length; i++) {
    var parameter = parameters[i];

    if (
      !parameter ||
      !parameter.name
    ) {
      continue;
    }

    formPayload[parameter.name] =
      parameter.value;

    /*
     * ค่า key คือ stagedUploadPath
     * ที่ใช้ใน bulkOperationRunMutation
     */
    if (parameter.name === "key") {
      stagedUploadPath =
        parameter.value;
    }
  }

  if (!stagedUploadPath) {
    throw new Error(
      "ไม่พบ key ใน Staged Upload Parameters"
    );
  }

  /*
   * file ต้องถูกเพิ่มท้ายสุด
   */
  formPayload.file = jsonlBlob;

  var uploadResponse = UrlFetchApp.fetch(
    stagedTarget.url,
    {
      method: "post",
      payload: formPayload,
      muteHttpExceptions: true
    }
  );

  var uploadStatus =
    uploadResponse.getResponseCode();

  var uploadText =
    uploadResponse.getContentText();

  /*
   * Shopify มักตอบ 201
   * รองรับทุกค่าในช่วง 2xx
   */
  if (
    uploadStatus < 200 ||
    uploadStatus >= 300
  ) {
    throw new Error(
      "Upload JSONL ล้มเหลว HTTP " +
      uploadStatus +
      ": " +
      uploadText.substring(0, 1000)
    );
  }

  return {
    status: uploadStatus,
    stagedUploadPath: stagedUploadPath
  };
}

// Fallback alias for backward compatibility across Google Apps Script project
function callGraphQL_(queryOrPayload, variables) {
  return callPriceGraphQL_(queryOrPayload, variables);
}


// ============================================================
// CHECK BULK OPERATION STATUS
// ============================================================

function checkCurrentPriceBulkOperation() {
  console.log("================================================");
  console.log("🔍 ตรวจสอบสถานะ Bulk Operation");
  console.log("================================================");

  try {
    var properties =
      PropertiesService.getScriptProperties();

    var operationId =
      properties.getProperty(
        SHOPIFY_PRICE_CONFIG.PROP_BULK_OPERATION_ID
      );

    if (!operationId) {
      console.warn(
        "⚠️ ไม่พบ Bulk Operation ID ที่บันทึกไว้"
      );

      return;
    }

    var query = `
      query checkBulkOperation($id: ID!) {
        bulkOperation(id: $id) {
          id
          status
          errorCode
          type
          objectCount
          rootObjectCount
          fileSize
          url
          partialDataUrl
          createdAt
          completedAt
        }
      }
    `;

    var response = callShopifyGraphQL_(
      query,
      {
        id: operationId
      }
    );

    var operation =
      response &&
      response.data &&
      response.data.bulkOperation;

    if (!operation) {
      console.warn(
        "⚠️ Shopify ไม่พบ Bulk Operation นี้"
      );

      return;
    }

    console.log(
      "Operation ID    : " +
      operation.id
    );

    console.log(
      "Status          : " +
      operation.status
    );

    console.log(
      "Processed       : " +
      operation.objectCount
    );

    console.log(
      "Root Objects    : " +
      operation.rootObjectCount
    );

    console.log(
      "Error Code      : " +
      (operation.errorCode || "-")
    );

    console.log(
      "Created At      : " +
      operation.createdAt
    );

    console.log(
      "Completed At    : " +
      (operation.completedAt || "-")
    );

    console.log(
      "Result URL      : " +
      (operation.url || "-")
    );

    console.log(
      "Partial URL     : " +
      (operation.partialDataUrl || "-")
    );

    console.log("================================================");

  } catch (error) {
    console.error(
      error && error.stack
        ? error.stack
        : String(error)
    );

    throw error;
  }
}


// ============================================================
// CLEAR SAVED TOKEN
// ใช้เมื่อเปลี่ยน Client Secret หรือ Token มีปัญหา
// ============================================================

function clearShopifyPriceToken() {
  var properties =
    PropertiesService.getScriptProperties();

  properties.deleteProperty(
    SHOPIFY_PRICE_CONFIG.PROP_ACCESS_TOKEN
  );

  properties.deleteProperty(
    SHOPIFY_PRICE_CONFIG.PROP_TOKEN_EXPIRY
  );

  console.log(
    "✅ ล้าง Shopify Access Token ที่บันทึกไว้แล้ว"
  );
}
