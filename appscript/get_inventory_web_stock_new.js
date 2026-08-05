// ============================================================
// CONFIG
// ============================================================
var INV_SOURCE_SHEET = "inventory web";
var INV_TARGET_SHEET = "Inventory";
var INV_LOG_SHEET    = "Logrun script";

// Spreadsheet ID ของไฟล์ที่ใช้ XLOOKUP (Active products)
var ACTIVE_FILE_ID = "1-7ap--3aphttTb8M0cXYvVYmRGtZQKRxoUW3nvwuUNA";

// ============================================================
// MAIN FUNCTION
// ============================================================
/**
 * ดึงข้อมูลจาก Sheet "inventory web" แล้วเขียนลง Sheet "Inventory"
 *
 * Source → Target:
 *   A (Good ID)           → A
 *   B (Variant SKU)       → B
 *   -                     → C = XLOOKUP จาก Active file
 *   -                     → D = VLOOKUP จาก 'inventory web'!A:C (inventory website)
 *   -                     → E = D=C (check update)
 *   D (Inventory Item ID) → F
 */
function syncInventorySheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // --- 1. อ่านข้อมูลต้นทาง ---
  const srcSheet = ss.getSheetByName(INV_SOURCE_SHEET);
  if (!srcSheet) {
    Logger.log("❌ ไม่พบ Sheet: " + INV_SOURCE_SHEET);
    return;
  }

  const lastRow = srcSheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("⚠️ ไม่มีข้อมูลใน Sheet: " + INV_SOURCE_SHEET);
    return;
  }

  // อ่าน col A:D ทั้งหมด (ข้าม header แถวที่ 1)
  const srcData = srcSheet.getRange(2, 1, lastRow - 1, 4).getValues();
  const numDataRows = srcData.length;

  Logger.log("อ่านข้อมูล " + numDataRows + " แถวจาก '" + INV_SOURCE_SHEET + "'");

  // --- 2. เตรียม Sheet ปลายทาง ---
  let tgtSheet = ss.getSheetByName(INV_TARGET_SHEET);
  if (!tgtSheet) {
    tgtSheet = ss.insertSheet(INV_TARGET_SHEET);
  }

  // ขยาย rows/cols ให้พอก่อน clear (ป้องกัน out-of-bounds)
  const neededRows = numDataRows + 1; // +1 header
  if (tgtSheet.getMaxRows() < neededRows) {
    tgtSheet.insertRowsAfter(tgtSheet.getMaxRows(), neededRows - tgtSheet.getMaxRows());
  }
  if (tgtSheet.getMaxColumns() < 6) {
    tgtSheet.insertColumnsAfter(tgtSheet.getMaxColumns(), 6 - tgtSheet.getMaxColumns());
  }

  // ล้างเนื้อหาเดิม (รวม formula เก่า)
  tgtSheet.clearContents();

  // --- 3. เขียน Header ---
  const headers = [["Good ID", "Variant SKU", "Inventory quantity", "inventory website", "check update", "Inventory Item ID"]];
  tgtSheet.getRange(1, 1, 1, 6).setValues(headers).setFontWeight("bold");
  tgtSheet.setFrozenRows(1);

  // --- 4. เขียนค่า A, B (bulk) ---
  const abData = srcData.map(function(row) {
    return [
      row[0] != null ? row[0] : "",  // A: Good ID
      row[1] != null ? row[1] : ""   // B: Variant SKU
    ];
  });
  tgtSheet.getRange(2, 1, numDataRows, 2).setValues(abData);

  // --- 5. เขียนค่า F = source D (Inventory Item ID) ---
  const fData = srcData.map(function(row) {
    return [row[3] != null ? row[3] : ""];
  });
  tgtSheet.getRange(2, 6, numDataRows, 1).setValues(fData);

  // --- 6. ใส่สูตร C, D, E ให้กับทุกแถว ---
  const formulasCDE = [];
  for (let i = 2; i <= numDataRows + 1; i++) {
    formulasCDE.push([
      '=XLOOKUP(A' + i + ', IMPORTRANGE("' + ACTIVE_FILE_ID + '", "\'Active\'!B2:B"), IMPORTRANGE("' + ACTIVE_FILE_ID + '", "\'Active\'!M2:M"), 0)',
      '=VLOOKUP(A' + i + ', \'' + INV_SOURCE_SHEET + '\'!A:C, 3, FALSE)',
      '=IF(A' + i + '="","", D' + i + '=C' + i + ')'
    ]);
  }
  tgtSheet.getRange(2, 3, numDataRows, 3).setFormulas(formulasCDE);

  SpreadsheetApp.flush();

  const msg = "✅ Sync สำเร็จ " + numDataRows + " รายการ → '" + INV_TARGET_SHEET + "'";
  Logger.log(msg);

  // --- 8. บันทึก Log ---
  writeInvLog_(ss, numDataRows, msg);
}

// ============================================================
// HELPER: เขียน Log ลง Sheet "Logrun script"
// ============================================================
function writeInvLog_(ss, rowCount, statusMsg) {
  try {
    let logSheet = ss.getSheetByName(INV_LOG_SHEET);
    if (!logSheet) {
      logSheet = ss.insertSheet(INV_LOG_SHEET);
      logSheet.getRange(1, 1, 1, 3)
        .setValues([["Timestamp", "Rows", "Status"]])
        .setFontWeight("bold");
      logSheet.setFrozenRows(1);
    }
    const ts = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      "yyyy-MM-dd HH:mm:ss"
    );
    logSheet.appendRow([ts, rowCount, statusMsg || "Completed"]);
  } catch (e) {
    Logger.log("⚠️ Log error: " + e);
  }
}
