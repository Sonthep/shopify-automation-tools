// ============================================================
// CONFIG & CONSTANTS
// ============================================================
var SOURCE_SHEET_NAME = "Spare Parts1";
var TARGET_NO_DISCOUNT_SHEET = "update_no_discount";
var TARGET_WITH_DISCOUNT_SHEET = "update_with_discount";
var LOG_SHEET_NAME = "Log run script";

// IMPORTRANGE Spreadsheet ID & Target Range
var EXPORT_SPREADSHEET_ID = "1hfHjhC7WdjVDT7qHt19PL8AnxlhTJ6rbbh-N4UBQJBA";
var EXPORT_RANGE = "Products Export!A:D";

// ============================================================
// UI MENU
// ============================================================
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('⚙️ Spare Parts Tools')
    .addItem('แยกราคาอะไหล่ (Split Prices)', 'splitPriceSparepart')
    .addToUi();
}

// ============================================================
// MAIN FUNCTION: splitPriceSparepart
// ============================================================
/**
 * ดึงข้อมูลจาก Sheet 'Spare Parts1':
 * - ถ้า Column D (Price Web) == 0 หรือ Column B (GoodCode) มีคำว่า 'KIT2':
 *   -> ย้ายไป Sheet 'update_no_discount' (5 คอลัมน์: GoodID, GoodCode, Price, Product GID, Variant GID)
 * - ถ้า Column D (Price Web) > 0 และไม่มี 'KIT2':
 *   -> ย้ายไป Sheet 'update_with_discount' (6 คอลัมน์: GoodID, GoodCode, Compare-at price, Price Web, Product GID, Variant GID)
 * 
 * คอลัมน์ Product GID และ Variant GID จะใส่สูตร IFERROR + VLOOKUP(IMPORTRANGE(...)) อัตโนมัติ
 * และบันทึกประวัติลงใน Sheet "Log run script"
 */
function splitPriceSparepart() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sourceSheet = ss.getSheetByName(SOURCE_SHEET_NAME);
  
  if (!sourceSheet) {
    const errMsg = `❌ ไม่พบ Sheet ต้นทางชื่อ "${SOURCE_SHEET_NAME}"`;
    Logger.log(errMsg);
    writeRunLogToSheet_(SOURCE_SHEET_NAME, 0, 0, 0, errMsg);
    return;
  }
  
  const lastRow = sourceSheet.getLastRow();
  const lastCol = sourceSheet.getLastColumn();
  
  if (lastRow < 2) {
    const warnMsg = `⚠️ ไม่พบข้อมูลใน Sheet "${SOURCE_SHEET_NAME}"`;
    Logger.log(warnMsg);
    writeRunLogToSheet_(SOURCE_SHEET_NAME, 0, 0, 0, warnMsg);
    return;
  }
  
  // อ่านข้อมูลทั้งหมดรวม Header (Column A = GoodID, B = GoodCode, C = ราคาสินค้า, D = Price Web)
  const data = sourceSheet.getRange(1, 1, lastRow, lastCol).getValues();
  const header = data[0];
  const rows = data.slice(1);
  
  const hColA = header[0] || "GoodID";
  const hColB = header[1] || "GoodCode";
  const hColD = header[3] || "Price Web";
  
  const noDiscountHeaders = [hColA, hColB, "Price", "Product GID", "Variant GID"];
  const withDiscountHeaders = [hColA, hColB, "Compare-at price", hColD, "Product GID", "Variant GID"];
  
  const noDiscountRows = [noDiscountHeaders];
  const withDiscountRows = [withDiscountHeaders];
  
  let noDiscRowCounter = 2;   // แถวแรกของข้อมูลใน Sheet คือแถวที่ 2
  let withDiscRowCounter = 2; // แถวแรกของข้อมูลใน Sheet คือแถวที่ 2
  
  rows.forEach(row => {
    const goodCode = String(row[1] || "").trim().toUpperCase(); // Column B: GoodCode
    const priceWebRaw = row[3]; // Column D: Price Web
    const priceWeb = parseFloat(priceWebRaw) || 0;
    
    // เงื่อนไข: Column D = 0 หรือ Column B มีคำว่า KIT2
    const isKit2 = goodCode.indexOf("KIT2") !== -1;
    
    if (priceWeb === 0 || isKit2) {
      // update_no_discount: GoodID, GoodCode, Price, Product GID (Formula), Variant GID (Formula)
      const prodGidFormula = `=IFERROR(VLOOKUP(A${noDiscRowCounter}, IMPORTRANGE("${EXPORT_SPREADSHEET_ID}","${EXPORT_RANGE}"), 3, FALSE), "")`;
      const varGidFormula = `=IFERROR(VLOOKUP(A${noDiscRowCounter}, IMPORTRANGE("${EXPORT_SPREADSHEET_ID}","${EXPORT_RANGE}"), 4, FALSE), "")`;
      
      noDiscountRows.push([row[0], row[1], row[2], prodGidFormula, varGidFormula]);
      noDiscRowCounter++;
    } else {
      // update_with_discount: GoodID, GoodCode, Compare-at price, Price Web, Product GID (Formula), Variant GID (Formula)
      const prodGidFormula = `=IFERROR(VLOOKUP(A${withDiscRowCounter}, IMPORTRANGE("${EXPORT_SPREADSHEET_ID}","${EXPORT_RANGE}"), 3, FALSE), "")`;
      const varGidFormula = `=IFERROR(VLOOKUP(A${withDiscRowCounter}, IMPORTRANGE("${EXPORT_SPREADSHEET_ID}","${EXPORT_RANGE}"), 4, FALSE), "")`;
      
      withDiscountRows.push([row[0], row[1], row[2], row[3], prodGidFormula, varGidFormula]);
      withDiscRowCounter++;
    }
  });
  
  // เขียนข้อมูลลง Sheet ปลายทาง
  writeToTargetSheet_(ss, TARGET_NO_DISCOUNT_SHEET, noDiscountRows);
  writeToTargetSheet_(ss, TARGET_WITH_DISCOUNT_SHEET, withDiscountRows);
  
  const totalProcessed = rows.length;
  const noDiscCount = noDiscountRows.length - 1;
  const withDiscCount = withDiscountRows.length - 1;
  
  const statusMsg = `แยกข้อมูลสำเร็จ: ${TARGET_NO_DISCOUNT_SHEET} (${noDiscCount} รายการ), ${TARGET_WITH_DISCOUNT_SHEET} (${withDiscCount} รายการ)`;
  Logger.log(`✅ ` + statusMsg);
  
  // บันทึก Log ลง Sheet "Log run script"
  writeRunLogToSheet_("Split Spareparts", totalProcessed, noDiscCount + withDiscCount, 0, statusMsg);
}

// ============================================================
// HELPER: เขียนข้อมูลลง Sheet ปลายทาง
// ============================================================
function writeToTargetSheet_(ss, sheetName, dataRows) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  } else {
    sheet.clear(); // เคลียร์ทั้งข้อมูล รูปแบบ และสูตรเดิม
  }
  
  if (!dataRows || dataRows.length === 0) return;
  
  const targetRows = dataRows.length;
  const targetCols = dataRows[0].length;
  
  const currentRows = sheet.getMaxRows();
  const currentCols = sheet.getMaxColumns();
  
  // ปรับจำนวนคอลัมน์ให้พอดี
  if (currentCols < targetCols) {
    sheet.insertColumnsAfter(currentCols, targetCols - currentCols);
  } else if (currentCols > targetCols) {
    sheet.deleteColumns(targetCols + 1, currentCols - targetCols);
  }
  
  // ปรับจำนวนแถวให้พอดี
  if (currentRows < targetRows) {
    sheet.insertRowsAfter(currentRows, targetRows - currentRows);
  }
  
  // เขียนข้อมูลรวมสูตรลงชีต
  sheet.getRange(1, 1, targetRows, targetCols).setValues(dataRows);
  
  // จัดรูปแบบหัวตาราง
  sheet.getRange(1, 1, 1, targetCols).setFontWeight("bold");
  sheet.setFrozenRows(1);
}

// ============================================================
// HELPER: WRITE RUN LOG TO SHEET "Log run script"
// ============================================================

/**
 * บันทึกประวัติการรันลงใน Sheet "Log run script"
 */
function writeRunLogToSheet_(targetName, totalItems, successCount, failedCount, statusMsg) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let logSheet = ss.getSheetByName(LOG_SHEET_NAME);
    
    // ถ้ายังไม่มี Sheet "Log run script" ให้สร้างใหม่และใส่ Header
    if (!logSheet) {
      logSheet = ss.insertSheet(LOG_SHEET_NAME);
      const headers = ["Timestamp", "Target Sheet", "Total Items", "Success", "Failed / Skipped", "Status Message"];
      logSheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
      logSheet.setFrozenRows(1);
    }
    
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT+7", "yyyy-MM-dd HH:mm:ss");
    logSheet.appendRow([
      timestamp,
      targetName,
      totalItems,
      successCount,
      failedCount,
      statusMsg || "Completed"
    ]);
    
    Logger.log(`📝 บันทึก Log ลงใน Sheet "${LOG_SHEET_NAME}" เรียบร้อยแล้ว`);
  } catch (e) {
    Logger.log("⚠️ เกิดข้อผิดพลาดในการบันทึก Log ลง Sheet: " + e);
  }
}
