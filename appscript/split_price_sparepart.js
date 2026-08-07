// ============================================================
// SPARE PART PRICE SPLIT — GOOGLE SHEETS API VERSION
// ============================================================

function spsConfig_() {
  return {
    // ชีตต้นทางในไฟล์ปัจจุบัน
    SOURCE_SHEET_NAME: "Spare Parts1",
    PRICE_WEBSITE_SHEET_NAME: "price website",

    // ชีตผลลัพธ์ในไฟล์ปัจจุบัน
    TARGET_NO_DISCOUNT_SHEET: "update_no_discount",
    TARGET_WITH_DISCOUNT_SHEET: "update_with_discount",

    // ชีตบันทึก Log
    LOG_SHEET_NAME: "Log run script",

    // แบ่งอ่านและเขียน ลดโอกาส 503 / Timeout
    READ_CHUNK_SIZE: 5000,
    WRITE_CHUNK_SIZE: 5000,

    // จำนวนครั้งที่ลองใหม่เมื่อ API มีปัญหา
    MAX_RETRY: 5,

    // จำกัดจำนวนแถวสำหรับการทดสอบ (เช่น 10 คือทดสอบ 10 แถวแรก, 0 หรือ null คือประมวลผลทั้งหมด)
    TEST_LIMIT_ROWS: 0
  };
}


// ============================================================
// UI MENU
// ============================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("⚙️ Spare Parts Tools")
    .addItem(
      "แยกราคาอะไหล่ (Split Prices)",
      "splitPriceSparepart"
    )
    .addItem(
      "🧪 ทดสอบแยกราคา (10 แถวแรก)",
      "splitPriceSparepartTest10Rows"
    )
    .addSeparator()
    .addItem(
      "🛑 ปลด Lock ฉุกเฉิน (Release Lock)",
      "releaseSplitLock"
    )
    .addToUi();
}

function splitPriceSparepartTest10Rows() {
  splitPriceSparepartSpreadsheetApp_(10);
}

// ปลด Lock ฉุกเฉิน — ใช้เมื่อ script ค้างและ lock ยังไม่ถูกปล่อยอัตโนมัติ
// (lock จะหมดอายุเองใน ~6 นาที แต่ใช้ function นี้ปลดได้ทันที)
function releaseSplitLock() {
  try {
    const lock = LockService.getScriptLock();
    lock.releaseLock();
    SpreadsheetApp.getActive().toast("✅ ปลด Lock สำเร็จ ลองรัน splitPriceSparepart ได้ใหม่แล้ว", "🛑 Release Lock", 5);
    console.log("ปลด LockService.ScriptLock สำเร็จ");
  } catch (e) {
    SpreadsheetApp.getActive().toast("⚠️ ไม่มี Lock ที่ต้องปลด: " + e.message, "🛑 Release Lock", 5);
    console.log("ไม่มี lock หรือปลดไม่สำเร็จ: " + e.message);
  }
}

// ============================================================
// TEST FUNCTION: อ่านข้อมูลด้วย SpreadsheetApp (ไม่ใช้ Sheets Advanced API)
// ใช้สำหรับทดสอบเท่านั้น เพราะเร็วและเสถียรกว่า
// ============================================================
function splitPriceSparepartSpreadsheetApp_(limitRows) {
  const cfg = spsConfig_();
  const limitR = limitRows || cfg.TEST_LIMIT_ROWS || 10;
  const startedAt = Date.now();

  console.log("===== START splitPriceSparepartSpreadsheetApp_ (limit=" + limitR + ") =====");

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ---- อ่าน Spare Parts1 ----
  const srcSheet = ss.getSheetByName(cfg.SOURCE_SHEET_NAME);
  if (!srcSheet) throw new Error('ไม่พบชีต "' + cfg.SOURCE_SHEET_NAME + '"');

  const lastRow = srcSheet.getLastRow();
  const effectiveLastRow = Math.min(lastRow, limitR + 1);
  const sourceValues = srcSheet.getRange(1, 1, effectiveLastRow, 4).getValues();
  console.log("อ่าน Spare Parts1 สำเร็จ: " + (effectiveLastRow - 1) + " แถว (จาก " + (lastRow - 1) + " แถวทั้งหมด)");

  // ---- อ่าน price website ----
  const pwSheet = ss.getSheetByName(cfg.PRICE_WEBSITE_SHEET_NAME);
  if (!pwSheet) throw new Error('ไม่พบชีต "' + cfg.PRICE_WEBSITE_SHEET_NAME + '"');

  const pwLastRow = pwSheet.getLastRow();
  const pwValues = pwSheet.getRange(1, 1, pwLastRow, 4).getValues();
  console.log("อ่าน " + cfg.PRICE_WEBSITE_SHEET_NAME + " สำเร็จ: " + (pwLastRow - 1) + " แถว");

  // ---- สร้าง Lookup Map ----
  const gidLookup = new Map();
  for (let i = 1; i < pwValues.length; i++) {
    const row = pwValues[i];
    const key = String(row[0] || "").trim();
    if (key === "" || gidLookup.has(key)) continue;
    gidLookup.set(key, { productGid: row[2] || "", variantGid: row[3] || "" });
  }
  console.log("สร้าง Lookup สำเร็จ: " + gidLookup.size + " รายการ");

  // ---- แยกข้อมูล ----
  const header = sourceValues[0] || [];
  const goodIdHeader = header[0] || "GoodID";
  const goodCodeHeader = header[1] || "GoodCode";
  const priceHeader = header[2] || "Price";

  const noDiscountRows = [[goodIdHeader, goodCodeHeader, priceHeader, "price website", "check price update", "Product GID", "Variant GID"]];
  const withDiscountRows = [[goodIdHeader, goodCodeHeader, "Compare At Price", "Price", "Compare At Price Website", "Price Website", "check Compare-at price update", "check price update", "Product GID", "Variant GID"]];

  let noCount = 0, withCount = 0, missingGid = 0;

  for (let i = 1; i < sourceValues.length; i++) {
    const row = sourceValues[i];
    const goodId = row[0] !== undefined ? row[0] : "";
    const goodCodeRaw = row[1] !== undefined ? row[1] : "";
    const originalPrice = row[2] !== undefined ? row[2] : "";
    const priceWebRaw = row[3] !== undefined ? row[3] : "";
    const goodCode = String(goodCodeRaw || "").trim().toUpperCase();
    const key = String(goodId || "").trim();

    if (key === "" && goodCode === "") continue;

    const priceWeb = parseFloat(priceWebRaw) || 0;
    const isKit2 = goodCode.indexOf("KIT2") !== -1;
    const gidData = gidLookup.get(key);
    let productGid = "", variantGid = "";
    if (gidData) { productGid = gidData.productGid; variantGid = gidData.variantGid; }
    else missingGid++;

    if (priceWeb === 0 || isKit2) {
      const r = noDiscountRows.length + 1;
      noDiscountRows.push([goodId, goodCodeRaw, originalPrice, "=VLOOKUP(A" + r + ",'price website'!A:E,5,false)", "=C" + r + "=D" + r, productGid, variantGid]);
      noCount++;
    } else {
      const r = withDiscountRows.length + 1;
      withDiscountRows.push([goodId, goodCodeRaw, originalPrice, priceWebRaw,
        "=VLOOKUP(A" + r + ",'price website'!A:G,6,false)",
        "=VLOOKUP(A" + r + ",'price website'!A:G,5,false)",
        "=C" + r + "=E" + r, "=D" + r + "=F" + r, productGid, variantGid]);
      withCount++;
    }
  }

  console.log("no_discount: " + noCount + " แถว | with_discount: " + withCount + " แถว | ไม่พบ GID: " + missingGid);

  // ---- เขียนลง Sheet ----
  function writeToSheet_(sheetName, dataRows) {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) sheet = ss.insertSheet(sheetName);
    sheet.clearContents();
    if (dataRows.length === 0) return;
    sheet.getRange(1, 1, dataRows.length, dataRows[0].length).setValues(dataRows);
    sheet.getRange(1, 1, 1, dataRows[0].length).setFontWeight("bold");
    sheet.setFrozenRows(1);
    console.log("เขียน " + sheetName + " สำเร็จ: " + (dataRows.length - 1) + " แถว");
  }

  writeToSheet_(cfg.TARGET_NO_DISCOUNT_SHEET, noDiscountRows);
  writeToSheet_(cfg.TARGET_WITH_DISCOUNT_SHEET, withDiscountRows);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log("===== FINISH ใช้เวลา " + elapsed + " วินาที =====");
}



// ============================================================
// MAIN FUNCTION
// ============================================================

function splitPriceSparepart(limitRows) {
  const cfg = spsConfig_();
  if (typeof limitRows === "number" && limitRows > 0) {
    cfg.TEST_LIMIT_ROWS = limitRows;
  }
  const startedAt = Date.now();

  if (typeof Sheets === "undefined") {
    throw new Error(
      "ยังไม่ได้เปิด Google Sheets API กรุณาไปที่ บริการ → + → Google Sheets API → เพิ่ม"
    );
  }

  const lock = LockService.getScriptLock();

  if (!lock.tryLock(10000)) {
    throw new Error(
      "มีสคริปต์ splitPriceSparepart กำลังทำงานอยู่แล้ว กรุณารออีกสักครู่แล้วลองใหม่"
    );
  }

  const currentSpreadsheet =
    SpreadsheetApp.getActiveSpreadsheet();

  if (!currentSpreadsheet) {
    lock.releaseLock();

    throw new Error(
      "ไม่พบไฟล์ Google Sheets ปลายทาง"
    );
  }

  const targetSpreadsheetId =
    currentSpreadsheet.getId();

  let totalProcessed = 0;
  let noDiscountCount = 0;
  let withDiscountCount = 0;
  let missingGidCount = 0;
  let skippedCount = 0;

  try {
    console.log(
      "===== START splitPriceSparepart ====="
    );

    console.log(
      "ไฟล์ปลายทาง ID: " +
      targetSpreadsheetId
    );

    console.log(
      "ชีตต้นทาง: [" +
      cfg.SOURCE_SHEET_NAME +
      "]"
    );

    console.log(
      "ชีต price website: [" +
      cfg.PRICE_WEBSITE_SHEET_NAME +
      "]"
    );

    // ========================================================
    // 1. ตรวจสอบชีตในไฟล์ปัจจุบัน + สร้างชีตปลายทาง
    // (รวมเป็น 1 API call เพื่อความเร็ว)
    // ========================================================

    console.log(
      "1/8 ตรวจสอบรายชื่อชีตและสร้างชีตผลลัพธ์"
    );

    // ── ดึง sheet map ครั้งเดียว แล้ว cache ไว้ใช้ตลอด ──
    let targetSheetMap =
      spsGetSpreadsheetSheetMap_(
        targetSpreadsheetId,
        cfg
      );

    console.log(
      "รายชื่อชีต: " +
      Object.keys(targetSheetMap)
        .map(function (name) {
          return "[" + name + "]";
        })
        .join(", ")
    );

    if (
      !targetSheetMap[
        cfg.SOURCE_SHEET_NAME
      ]
    ) {
      throw new Error(
        'ไม่พบชีตต้นทาง "' +
        cfg.SOURCE_SHEET_NAME +
        '" ในไฟล์ปัจจุบัน'
      );
    }

    // ========================================================
    // 2. สร้างชีตปลายทาง หากยังไม่มี
    // ========================================================

    console.log(
      "2/8 ตรวจสอบและสร้างชีตผลลัพธ์"
    );

    const sheetsToEnsure = [
      cfg.TARGET_NO_DISCOUNT_SHEET,
      cfg.TARGET_WITH_DISCOUNT_SHEET,
      cfg.LOG_SHEET_NAME
    ];
    const missingSheetsForCreate = sheetsToEnsure.filter(
      function(name) { return !targetSheetMap[name]; }
    );

    if (missingSheetsForCreate.length > 0) {
      // มีชีตที่ขาด → สร้าง + อัปเดต sheetMap
      targetSheetMap = spsEnsureSheetsExist_(
        targetSpreadsheetId,
        sheetsToEnsure,
        cfg
      );
    }

    // ========================================================
    // 3. อ่านข้อมูล Spare Parts1
    // ========================================================

    console.log(
      "3/8 ตรวจสอบจำนวนแถว Spare Parts1"
    );

    const sourceLastRow =
      spsGetLastDataRow_(
        targetSpreadsheetId,
        cfg.SOURCE_SHEET_NAME,
        "A",
        cfg
      );

    const effectiveLastRow =
      cfg.TEST_LIMIT_ROWS && cfg.TEST_LIMIT_ROWS > 0
        ? Math.min(sourceLastRow, cfg.TEST_LIMIT_ROWS + 1)
        : sourceLastRow;

    console.log(
      "Spare Parts1 มีข้อมูลถึงแถว: " +
      sourceLastRow +
      (cfg.TEST_LIMIT_ROWS ? " (จำกัดอ่าน " + cfg.TEST_LIMIT_ROWS + " แถวสำหรับทดสอบ)" : "")
    );

    if (sourceLastRow < 2) {
      const warningMessage =
        'ไม่พบข้อมูลในชีต "' +
        cfg.SOURCE_SHEET_NAME +
        '"';

      console.log(warningMessage);

      spsWriteRunLog_(
        targetSpreadsheetId,
        "Split Spareparts",
        0,
        0,
        0,
        warningMessage,
        cfg
      );

      return;
    }

    console.log(
      "4/8 อ่านข้อมูล Spare Parts1 คอลัมน์ A:D"
    );

    const sourceValues =
      spsReadRangeChunked_(
        targetSpreadsheetId,
        cfg.SOURCE_SHEET_NAME,
        "A",
        "D",
        1,
        effectiveLastRow,
        cfg.READ_CHUNK_SIZE,
        "อ่าน Spare Parts1",
        cfg
      );

    if (sourceValues.length < 2) {
      throw new Error(
        "อ่าน Spare Parts1 ไม่พบข้อมูล"
      );
    }

    console.log(
      "อ่าน Spare Parts1 สำเร็จ: " +
      (sourceValues.length - 1) +
      " แถว"
    );

    // ========================================================
    // 4. ตรวจสอบ price website
    // ========================================================

    console.log(
      "5/8 ตรวจสอบชีต " + cfg.PRICE_WEBSITE_SHEET_NAME
    );

    if (
      !targetSheetMap[
        cfg.PRICE_WEBSITE_SHEET_NAME
      ]
    ) {
      throw new Error(
        'ไม่พบชีต "' +
        cfg.PRICE_WEBSITE_SHEET_NAME +
        '" ในไฟล์ปัจจุบัน'
      );
    }

    // ========================================================
    // 5. สร้าง Good ID Lookup จาก price website
    // ========================================================

    console.log(
      "6/8 สร้าง Lookup Product GID และ Variant GID จาก " + cfg.PRICE_WEBSITE_SHEET_NAME
    );

    const gidLookup =
      spsBuildExportGidLookup_(
        targetSpreadsheetId,
        cfg
      );

    console.log(
      "สร้าง Lookup สำเร็จ: " +
      gidLookup.size +
      " รายการ"
    );

    // ========================================================
    // 6. แยกข้อมูล
    // ========================================================

    console.log(
      "7/8 เริ่มแยกราคาอะไหล่"
    );

    const header =
      sourceValues[0] || [];

    const goodIdHeader =
      header[0] || "GoodID";

    const goodCodeHeader =
      header[1] || "GoodCode";

    const priceHeader =
      header[2] || "Price";

    const priceWebHeader =
      header[3] || "Price Web";

    const noDiscountRows = [[
      goodIdHeader,
      goodCodeHeader,
      priceHeader,
      "price website",
      "check price update",
      "Product GID",
      "Variant GID"
    ]];

    const withDiscountRows = [[
      goodIdHeader,
      goodCodeHeader,
      "Compare At Price",
      "Price",
      "Compare At Price Website",
      "Price Website",
      "check Compare-at price update",
      "check price update",
      "Product GID",
      "Variant GID"
    ]];

    for (
      let rowIndex = 1;
      rowIndex < sourceValues.length;
      rowIndex++
    ) {
      const row =
        sourceValues[rowIndex] || [];

      const goodId =
        row[0] !== undefined
          ? row[0]
          : "";

      const goodCodeRaw =
        row[1] !== undefined
          ? row[1]
          : "";

      const originalPrice =
        row[2] !== undefined
          ? row[2]
          : "";

      const priceWebRaw =
        row[3] !== undefined
          ? row[3]
          : "";

      const goodIdKey =
        spsNormalizeLookupKey_(goodId);

      const goodCode =
        String(goodCodeRaw || "")
          .trim()
          .toUpperCase();

      // ข้ามแถวว่าง
      if (
        goodIdKey === "" &&
        goodCode === ""
      ) {
        skippedCount++;
        continue;
      }

      totalProcessed++;

      const priceWeb =
        spsParseNumber_(priceWebRaw);

      const isKit2 =
        goodCode.indexOf("KIT2") !== -1;

      const gidData =
        gidLookup.get(goodIdKey);

      let productGid = "";
      let variantGid = "";

      if (gidData) {
        productGid =
          gidData.productGid || "";

        variantGid =
          gidData.variantGid || "";
      } else {
        missingGidCount++;
      }

      // D = 0 หรือ GoodCode มี KIT2
      if (
        priceWeb === 0 ||
        isKit2
      ) {
        const r = noDiscountRows.length + 1;
        noDiscountRows.push([
          goodId,
          goodCodeRaw,
          originalPrice,
          "=VLOOKUP(A" + r + ",'price website'!A:E,5,false)",
          "=C" + r + "=D" + r,
          productGid,
          variantGid
        ]);

        noDiscountCount++;

      } else {
        const r = withDiscountRows.length + 1;
        withDiscountRows.push([
          goodId,
          goodCodeRaw,
          originalPrice,
          priceWebRaw,
          "=VLOOKUP(A" + r + ",'price website'!A:G,6,false)",
          "=VLOOKUP(A" + r + ",'price website'!A:G,5,false)",
          "=C" + r + "=E" + r,
          "=D" + r + "=F" + r,
          productGid,
          variantGid
        ]);

        withDiscountCount++;
      }
    }

    console.log(
      "แยกข้อมูลสำเร็จ"
    );

    console.log(
      "update_no_discount: " +
      noDiscountCount +
      " รายการ"
    );

    console.log(
      "update_with_discount: " +
      withDiscountCount +
      " รายการ"
    );

    console.log(
      "ไม่พบ GID: " +
      missingGidCount +
      " รายการ"
    );

    console.log(
      "ข้ามแถวว่าง: " +
      skippedCount +
      " รายการ"
    );

    // ========================================================
    // 7. เขียนข้อมูลปลายทาง
    // ========================================================

    console.log(
      "8/8 เขียนข้อมูลลงชีตผลลัพธ์"
    );

    spsWriteTargetSheet_(
      targetSpreadsheetId,
      targetSheetMap[
        cfg.TARGET_NO_DISCOUNT_SHEET
      ],
      cfg.TARGET_NO_DISCOUNT_SHEET,
      noDiscountRows,
      cfg
    );

    spsWriteTargetSheet_(
      targetSpreadsheetId,
      targetSheetMap[
        cfg.TARGET_WITH_DISCOUNT_SHEET
      ],
      cfg.TARGET_WITH_DISCOUNT_SHEET,
      withDiscountRows,
      cfg
    );

    // ========================================================
    // 8. บันทึก Log
    // ========================================================

    const elapsedSeconds =
      (
        (Date.now() - startedAt) /
        1000
      ).toFixed(2);

    const statusMessage =
      "แยกข้อมูลสำเร็จ: " +
      cfg.TARGET_NO_DISCOUNT_SHEET +
      " (" +
      noDiscountCount +
      " รายการ), " +
      cfg.TARGET_WITH_DISCOUNT_SHEET +
      " (" +
      withDiscountCount +
      " รายการ), " +
      "ไม่พบ GID " +
      missingGidCount +
      " รายการ, " +
      "ข้ามแถวว่าง " +
      skippedCount +
      " รายการ, " +
      "ใช้เวลา " +
      elapsedSeconds +
      " วินาที";

    spsWriteRunLog_(
      targetSpreadsheetId,
      "Split Spareparts",
      totalProcessed,
      noDiscountCount +
        withDiscountCount,
      missingGidCount +
        skippedCount,
      statusMessage,
      cfg
    );

    console.log(statusMessage);

    console.log(
      "===== FINISH splitPriceSparepart ====="
    );

  } catch (error) {
    const errorMessage =
      "เกิดข้อผิดพลาด: " +
      String(
        error &&
        error.message
          ? error.message
          : error
      );

    console.error(errorMessage);

    if (
      error &&
      error.stack
    ) {
      console.error(error.stack);
    }

    try {
      spsWriteRunLog_(
        targetSpreadsheetId,
        "Split Spareparts",
        totalProcessed,
        noDiscountCount +
          withDiscountCount,
        missingGidCount +
          skippedCount,
        errorMessage,
        cfg
      );
    } catch (logError) {
      console.error(
        "บันทึก Log ไม่สำเร็จ: " +
        String(
          logError &&
          logError.message
            ? logError.message
            : logError
        )
      );
    }

    throw error;

  } finally {
    lock.releaseLock();
  }
}


// ============================================================
// BUILD GOOD ID → PRODUCT GID / VARIANT GID LOOKUP
// price website:
// A = Good ID (custom.good_id)
// C = Product GID
// D = Variant GID
// ============================================================

function spsBuildExportGidLookup_(spreadsheetId, cfg) {
  const lookup = new Map();
  const targetSheet = cfg.PRICE_WEBSITE_SHEET_NAME || "price website";

  console.log('อ่านข้อมูล GID จากชีต: [' + targetSheet + ']');

  const lastRow = spsGetLastDataRow_(spreadsheetId, targetSheet, "A", cfg);

  if (lastRow < 2) {
    console.log('ไม่พบข้อมูลในชีต "' + targetSheet + '"');
    return lookup;
  }

  console.log(
    targetSheet + " มีข้อมูลถึงแถว: " +
    lastRow
  );

  for (
    let startRow = 2;
    startRow <= lastRow;
    startRow += cfg.READ_CHUNK_SIZE
  ) {
    const endRow =
      Math.min(
        startRow +
          cfg.READ_CHUNK_SIZE -
          1,
        lastRow
      );

    console.log(
      "อ่าน " + targetSheet + " แถว " +
      startRow +
      "-" +
      endRow
    );

    const range =
      spsQuoteSheetName_(targetSheet) +
      "!A" +
      startRow +
      ":D" +
      endRow;

    const response =
      spsRetrySheetsApi_(
        function () {
          return Sheets
            .Spreadsheets
            .Values
            .get(
              spreadsheetId,
              range,
              {
                majorDimension:
                  "ROWS",

                valueRenderOption:
                  "UNFORMATTED_VALUE"
              }
            );
        },
        "อ่าน " + targetSheet + " " +
          startRow +
          "-" +
          endRow,
        cfg
      );

    const values =
      response.values || [];

    for (
      let index = 0;
      index < values.length;
      index++
    ) {
      const row =
        values[index] || [];

      const goodId =
        row[0] !== undefined
          ? row[0]
          : "";

      const key =
        spsNormalizeLookupKey_(
          goodId
        );

      if (key === "") {
        continue;
      }

      // ให้เหมือน XLOOKUP คือเอารายการแรก
      if (lookup.has(key)) {
        continue;
      }

      lookup.set(key, {
        productGid:
          row[2] !== undefined
            ? row[2]
            : "",

        variantGid:
          row[3] !== undefined
            ? row[3]
            : ""
      });
    }

    console.log(
      "สร้าง Lookup แล้ว: " +
      lookup.size +
      " รายการ"
    );
  }

  return lookup;
}


// ============================================================
// READ RANGE IN CHUNKS
// ============================================================

function spsReadRangeChunked_(
  spreadsheetId,
  sheetName,
  startColumn,
  endColumn,
  firstRow,
  lastRow,
  chunkSize,
  actionName,
  cfg
) {
  const output = [];

  for (
    let startRow = firstRow;
    startRow <= lastRow;
    startRow += chunkSize
  ) {
    const endRow =
      Math.min(
        startRow +
          chunkSize -
          1,
        lastRow
      );

    console.log(
      actionName +
      " แถว " +
      startRow +
      "-" +
      endRow
    );

    const range =
      spsQuoteSheetName_(sheetName) +
      "!" +
      startColumn +
      startRow +
      ":" +
      endColumn +
      endRow;

    const response =
      spsRetrySheetsApi_(
        function () {
          return Sheets
            .Spreadsheets
            .Values
            .get(
              spreadsheetId,
              range,
              {
                majorDimension:
                  "ROWS",

                valueRenderOption:
                  "UNFORMATTED_VALUE"
              }
            );
        },
        actionName +
          " " +
          startRow +
          "-" +
          endRow,
        cfg
      );

    const rows =
      response.values || [];

    for (
      let index = 0;
      index < rows.length;
      index++
    ) {
      output.push(
        rows[index] || []
      );
    }
  }

  return output;
}


// ============================================================
// GET LAST DATA ROW
// ── ใช้ Sheets.Spreadsheets.get metadata (includeGridData=false)
//    เร็วกว่ามากเพราะไม่โหลดข้อมูล cell เลย
//    แต่ rowCount คือขนาด sheet ไม่ใช่ last data row
//    จึงต้อง query ผ่าน Values API โดยอ่านเฉพาะ column เดียว
//    ด้วย majorDimension=COLUMNS → API return array เดียว ไม่ต้องนับ row by row
// ============================================================

function spsGetLastDataRow_(
  spreadsheetId,
  sheetName,
  columnLetter,
  cfg
) {
  const response =
    spsRetrySheetsApi_(
      function () {
        return Sheets
          .Spreadsheets
          .Values
          .get(
            spreadsheetId,
            spsQuoteSheetName_(sheetName) +
              "!" + columnLetter + ":" + columnLetter,
            {
              majorDimension: "COLUMNS",
              valueRenderOption: "UNFORMATTED_VALUE"
            }
          );
      },
      "ตรวจสอบแถวสุดท้าย " + sheetName,
      cfg
    );

  // majorDimension=COLUMNS → values[0] = array ค่าในคอลัมน์ ความยาว = จำนวนแถวจริง
  const col = (response.values || [])[0] || [];
  return col.length;
}


// ============================================================
// WRITE TARGET SHEET
// ============================================================

function spsWriteTargetSheet_(
  spreadsheetId,
  sheetInfo,
  sheetName,
  dataRows,
  cfg
) {
  if (
    !dataRows ||
    dataRows.length === 0
  ) {
    console.log(
      "ไม่มีข้อมูลสำหรับเขียน " +
      sheetName
    );

    return;
  }

  if (!sheetInfo) {
    throw new Error(
      'ไม่พบข้อมูล Sheet "' +
      sheetName +
      '"'
    );
  }

  const requiredRows =
    Math.max(
      dataRows.length,
      1
    );

  const requiredColumns =
    dataRows[0].length;

  const currentRows =
    sheetInfo.rowCount || 1000;

  const currentColumns =
    sheetInfo.columnCount || 26;

  const newGridProperties = {};
  const fieldNames = [];

  if (
    currentRows <
    requiredRows
  ) {
    newGridProperties.rowCount =
      requiredRows;

    fieldNames.push(
      "gridProperties.rowCount"
    );
  }

  if (
    currentColumns <
    requiredColumns
  ) {
    newGridProperties.columnCount =
      requiredColumns;

    fieldNames.push(
      "gridProperties.columnCount"
    );
  }

  // เพิ่มขนาดชีตหากพื้นที่ไม่พอ
  if (fieldNames.length > 0) {
    console.log(
      "เพิ่มขนาดชีต " +
      sheetName
    );

    spsRetrySheetsApi_(
      function () {
        return Sheets
          .Spreadsheets
          .batchUpdate(
            {
              requests: [
                {
                  updateSheetProperties: {
                    properties: {
                      sheetId:
                        sheetInfo.sheetId,

                      gridProperties:
                        newGridProperties
                    },

                    fields:
                      fieldNames.join(",")
                  }
                }
              ]
            },
            spreadsheetId
          );
      },
      "เพิ่มขนาดชีต " +
        sheetName,
      cfg
    );
  }

  // ล้าง A:Z เพื่อไม่ให้ข้อมูลเก่าเหลือ
  console.log(
    "ล้างข้อมูลเดิม " +
    sheetName +
    "!A:Z"
  );

  spsRetrySheetsApi_(
    function () {
      return Sheets
        .Spreadsheets
        .Values
        .clear(
          {},
          spreadsheetId,
          spsQuoteSheetName_(
            sheetName
          ) +
          "!A:Z"
        );
    },
    "ล้างข้อมูล " +
      sheetName,
    cfg
  );

  const lastColumn =
    spsColumnNumberToLetter_(
      requiredColumns
    );

  // เขียนทีละก้อน
  for (
    let startIndex = 0;
    startIndex < dataRows.length;
    startIndex +=
      cfg.WRITE_CHUNK_SIZE
  ) {
    const batch =
      dataRows.slice(
        startIndex,
        startIndex +
          cfg.WRITE_CHUNK_SIZE
      );

    const destinationStartRow =
      startIndex + 1;

    const destinationEndRow =
      destinationStartRow +
      batch.length -
      1;

    const range =
      spsQuoteSheetName_(
        sheetName
      ) +
      "!A" +
      destinationStartRow +
      ":" +
      lastColumn +
      destinationEndRow;

    spsRetrySheetsApi_(
      function () {
        return Sheets
          .Spreadsheets
          .Values
          .update(
            {
              majorDimension:
                "ROWS",

              values: batch
            },
            spreadsheetId,
            range,
            {
              valueInputOption:
                "USER_ENTERED",

              includeValuesInResponse:
                false
            }
          );
      },
      "เขียน " +
        sheetName +
        " แถว " +
        destinationStartRow +
        "-" +
        destinationEndRow,
      cfg
    );

    console.log(
      sheetName +
      ": เขียนแล้ว " +
      Math.min(
        startIndex +
          cfg.WRITE_CHUNK_SIZE,
        dataRows.length
      ) +
      "/" +
      dataRows.length +
      " แถว"
    );
  }

  // หัวตารางตัวหนาและ Freeze แถวแรก
  spsRetrySheetsApi_(
    function () {
      return Sheets
        .Spreadsheets
        .batchUpdate(
          {
            requests: [
              {
                repeatCell: {
                  range: {
                    sheetId:
                      sheetInfo.sheetId,

                    startRowIndex: 0,
                    endRowIndex: 1,

                    startColumnIndex: 0,
                    endColumnIndex:
                      requiredColumns
                  },

                  cell: {
                    userEnteredFormat: {
                      textFormat: {
                        bold: true
                      }
                    }
                  },

                  fields:
                    "userEnteredFormat.textFormat.bold"
                }
              },
              {
                updateSheetProperties: {
                  properties: {
                    sheetId:
                      sheetInfo.sheetId,

                    gridProperties: {
                      frozenRowCount: 1
                    }
                  },

                  fields:
                    "gridProperties.frozenRowCount"
                }
              }
            ]
          },
          spreadsheetId
        );
    },
    "จัดรูปแบบ " +
      sheetName,
    cfg
  );

  console.log(
    "เขียน " +
    sheetName +
    " สำเร็จทั้งหมด " +
    (dataRows.length - 1) +
    " รายการ"
  );
}


// ============================================================
// ENSURE SHEETS EXIST
// ============================================================

function spsEnsureSheetsExist_(
  spreadsheetId,
  requiredSheetNames,
  cfg
) {
  let sheetMap =
    spsGetSpreadsheetSheetMap_(
      spreadsheetId,
      cfg
    );

  const missingNames =
    requiredSheetNames.filter(
      function (sheetName) {
        return !sheetMap[sheetName];
      }
    );

  if (missingNames.length === 0) {
    return sheetMap;
  }

  console.log(
    "กำลังสร้างชีต: " +
    missingNames.join(", ")
  );

  const requests =
    missingNames.map(
      function (sheetName) {
        return {
          addSheet: {
            properties: {
              title: sheetName
            }
          }
        };
      }
    );

  spsRetrySheetsApi_(
    function () {
      return Sheets
        .Spreadsheets
        .batchUpdate(
          {
            requests: requests
          },
          spreadsheetId
        );
    },
    "สร้างชีตปลายทาง",
    cfg
  );

  sheetMap =
    spsGetSpreadsheetSheetMap_(
      spreadsheetId,
      cfg
    );

  return sheetMap;
}


// ============================================================
// GET SHEET METADATA
// ============================================================

function spsGetSpreadsheetSheetMap_(
  spreadsheetId,
  cfg
) {
  const metadata =
    spsRetrySheetsApi_(
      function () {
        return Sheets
          .Spreadsheets
          .get(
            spreadsheetId,
            {
              fields:
                "sheets(properties(" +
                "sheetId,title," +
                "gridProperties(" +
                "rowCount,columnCount" +
                ")" +
                "))"
            }
          );
      },
      "อ่านรายชื่อชีต",
      cfg
    );

  const map = {};
  const sheets =
    metadata.sheets || [];

  for (
    let index = 0;
    index < sheets.length;
    index++
  ) {
    const properties =
      sheets[index].properties || {};

    const gridProperties =
      properties.gridProperties || {};

    map[properties.title] = {
      sheetId:
        properties.sheetId,

      rowCount:
        gridProperties.rowCount ||
        1000,

      columnCount:
        gridProperties.columnCount ||
        26
    };
  }

  return map;
}


// ============================================================
// WRITE RUN LOG
// ============================================================

function spsWriteRunLog_(
  spreadsheetId,
  targetName,
  totalItems,
  successCount,
  failedCount,
  statusMessage,
  cfg
) {
  // ไม่เรียก spsEnsureSheetsExist_ ซ้ำ เพราะชีต Log ถูกสร้างใน step 2/8 แล้ว
  // (เรียกซ้ำหมายถึง API call เพิ่ม 1-2 ครั้งทุกครั้งที่ log)

  const headerRange =
    spsQuoteSheetName_(
      cfg.LOG_SHEET_NAME
    ) +
    "!A1:F1";

  const headerResponse =
    spsRetrySheetsApi_(
      function () {
        return Sheets
          .Spreadsheets
          .Values
          .get(
            spreadsheetId,
            headerRange,
            {
              valueRenderOption:
                "UNFORMATTED_VALUE"
            }
          );
      },
      "ตรวจสอบหัวตาราง Log",
      cfg
    );

  const existingHeader =
    headerResponse.values || [];

  if (
    existingHeader.length === 0
  ) {
    spsRetrySheetsApi_(
      function () {
        return Sheets
          .Spreadsheets
          .Values
          .update(
            {
              majorDimension:
                "ROWS",

              values: [[
                "Timestamp",
                "Target Sheet",
                "Total Items",
                "Success",
                "Failed / Skipped",
                "Status Message"
              ]]
            },
            spreadsheetId,
            headerRange,
            {
              valueInputOption:
                "RAW"
            }
          );
      },
      "สร้างหัวตาราง Log",
      cfg
    );
  }

  const timezone =
    Session.getScriptTimeZone() ||
    "Asia/Bangkok";

  const timestamp =
    Utilities.formatDate(
      new Date(),
      timezone,
      "yyyy-MM-dd HH:mm:ss"
    );

  spsRetrySheetsApi_(
    function () {
      return Sheets
        .Spreadsheets
        .Values
        .append(
          {
            majorDimension:
              "ROWS",

            values: [[
              timestamp,
              targetName,
              totalItems,
              successCount,
              failedCount,
              statusMessage ||
                "Completed"
            ]]
          },
          spreadsheetId,
          spsQuoteSheetName_(
            cfg.LOG_SHEET_NAME
          ) +
          "!A:F",
          {
            valueInputOption:
              "RAW",

            insertDataOption:
              "INSERT_ROWS"
          }
        );
    },
    "บันทึก Log",
    cfg
  );

  console.log(
    'บันทึก Log ลง "' +
    cfg.LOG_SHEET_NAME +
    '" สำเร็จ'
  );
}


// ============================================================
// RETRY SHEETS API
// ============================================================

function spsRetrySheetsApi_(
  callback,
  actionName,
  cfg
) {
  const maxAttempts =
    cfg.MAX_RETRY || 5;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    try {
      return callback();

    } catch (error) {
      const message =
        String(
          error &&
          error.message
            ? error.message
            : error
        );

      const retryable =
        /429|500|502|503|504|service is currently unavailable|internal error|backend error|rate limit|timed out|timeout/i
          .test(message);

      console.log(
        actionName +
        " ไม่สำเร็จ ครั้งที่ " +
        attempt +
        "/" +
        maxAttempts +
        ": " +
        message
      );

      if (
        !retryable ||
        attempt === maxAttempts
      ) {
        throw error;
      }

      const waitMilliseconds =
        Math.min(
          Math.pow(2, attempt) *
            1000 +
            Math.floor(
              Math.random() *
              1000
            ),
          32000
        );

      console.log(
        "รอ " +
        (
          waitMilliseconds /
          1000
        ).toFixed(1) +
        " วินาทีแล้วลองใหม่"
      );

      Utilities.sleep(
        waitMilliseconds
      );
    }
  }

  throw new Error(
    actionName +
    " ไม่สำเร็จ"
  );
}


// ============================================================
// UTILITIES
// ============================================================

function spsNormalizeLookupKey_(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value).trim();
}


function spsParseNumber_(
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return 0;
  }

  if (
    typeof value === "number"
  ) {
    return value;
  }

  const parsed =
    parseFloat(
      String(value)
        .replace(/,/g, "")
        .trim()
    );

  return isNaN(parsed)
    ? 0
    : parsed;
}


function spsQuoteSheetName_(
  sheetName
) {
  return (
    "'" +
    String(sheetName)
      .replace(/'/g, "''") +
    "'"
  );
}


function spsColumnNumberToLetter_(
  columnNumber
) {
  let result = "";
  let number =
    columnNumber;

  while (number > 0) {
    const remainder =
      (number - 1) % 26;

    result =
      String.fromCharCode(
        65 + remainder
      ) +
      result;

    number =
      Math.floor(
        (number - 1) /
        26
      );
  }

  return result;
}