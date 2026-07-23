// ============================================================
// CONFIG & CONSTANTS (Scoped object to prevent clashes with other gs files)
// ============================================================
var INVENTORY_CONFIG = {
  // Spreadsheet ID ของไฟล์ "รายการสินค้าทั้งหมดบนเว็บไซต์ active web sevenfive"
  SOURCE_SPREADSHEET_ID: "1hfHjhC7WdjVDT7qHt19PL8AnxlhTJ6rbbh-N4UBQJBA",
  SOURCE_SHEET_NAME: "Products Export",
  TARGET_SHEET_NAME: "Inventory",
  LOG_SHEET_NAME: "Log run script"
};

// ============================================================
// UI MENU
// ============================================================
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('📦 Inventory Tools')
    .addItem('1. ดึงข้อมูล Inventory จาก Products Export (Direct Value)', 'getInventoryFromProductsExport')
    .addItem('2. ใส่สูตร IMPORTRANGE ดึงข้อมูลสดอัตโนมัติ', 'applyImportRangeFormulas')
    .addToUi();
}

// ============================================================
// MAIN FUNCTION 1: ดึงข้อมูลและคัดลอกค่าโดยตรง (Direct Value - รวดเร็ว ปราศจากสูตรหมุน)
// ============================================================
/**
 * ดึงข้อมูล custom.good_id, Variant SKU, Inventory Item ID จาก "Products Export"
 * นำมาลงใน Sheet "Inventory":
 * - Column A: Good ID (จาก custom.good_id / Col A)
 * - Column B: Variant SKU (จาก Variant SKU / Col B)
 * - Column C: Inventory quantity (ปล่อยว่างไว้สำหรับใส่นับสต็อก)
 * - Column D: Inventory Item ID (จาก Inventory Item ID / Col E)
 */
function getInventoryFromProductsExport() {
  Logger.log("=== เริ่มดึงข้อมูล Inventory จาก Products Export ===");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. หา Sheet ต้นทาง (พยายามหาในไฟล์ปัจจุบันก่อน ถ้าไม่มีให้เปิดจาก SOURCE_SPREADSHEET_ID)
  let sourceSheet = ss.getSheetByName(INVENTORY_CONFIG.SOURCE_SHEET_NAME);
  if (!sourceSheet) {
    try {
      const sourceSS = SpreadsheetApp.openById(INVENTORY_CONFIG.SOURCE_SPREADSHEET_ID);
      sourceSheet = sourceSS.getSheetByName(INVENTORY_CONFIG.SOURCE_SHEET_NAME);
    } catch (e) {
      Logger.log("❌ ไม่สามารถเปิดไฟล์ต้นทางได้: " + e);
      writeInventoryLog_("Inventory Fetch", 0, 0, 0, "❌ ไม่สามารถเปิดไฟล์ต้นทาง ID " + INVENTORY_CONFIG.SOURCE_SPREADSHEET_ID);
      return;
    }
  }
  
  if (!sourceSheet) {
    const errMsg = `❌ ไม่พบ Sheet "${INVENTORY_CONFIG.SOURCE_SHEET_NAME}" ในไฟล์ต้นทาง`;
    Logger.log(errMsg);
    writeInventoryLog_("Inventory Fetch", 0, 0, 0, errMsg);
    return;
  }
  
  const lastRow = sourceSheet.getLastRow();
  const lastCol = sourceSheet.getLastColumn();
  
  if (lastRow < 2) {
    const warnMsg = `⚠️ ไม่พบข้อมูลใน Sheet "${INVENTORY_CONFIG.SOURCE_SHEET_NAME}"`;
    Logger.log(warnMsg);
    writeInventoryLog_("Inventory Fetch", 0, 0, 0, warnMsg);
    return;
  }
  
  // 2. อ่านข้อมูลทั้งหมดจากต้นทาง
  const data = sourceSheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = data[0].map(h => String(h).trim());
  const rows = data.slice(1);
  
  // ค้นหาตำแหน่งคอลัมน์จาก Header
  const goodIdIdx = findColIdx_(headers, ["custom.good_id", "Good ID", "GoodID"]);
  const variantSkuIdx = findColIdx_(headers, ["Variant SKU", "VariantSKU", "SKU"]);
  const invItemIdIdx = findColIdx_(headers, ["Inventory Item ID", "InventoryItemID", "inventory_item_id"]);
  
  // ตำแหน่งคอลัมน์มาตรฐาน (Default: A = custom.good_id (0), B = Variant SKU (1), E = Inventory Item ID (4))
  const colGoodId = goodIdIdx !== -1 ? goodIdIdx : 0;
  const colVariantSku = variantSkuIdx !== -1 ? variantSkuIdx : 1;
  const colInvItemId = invItemIdIdx !== -1 ? invItemIdIdx : 4;
  
  // 3. จัดเตรียมข้อมูลสำหรับ Sheet "Inventory"
  const targetHeaders = ["Good ID", "Variant SKU", "Inventory quantity", "Inventory Item ID"];
  const targetRows = [targetHeaders];
  
  rows.forEach(row => {
    const goodId = row[colGoodId] != null ? row[colGoodId] : "";
    const variantSku = row[colVariantSku] != null ? row[colVariantSku] : "";
    const invItemId = row[colInvItemId] != null ? row[colInvItemId] : "";
    
    // ข้ามแถวที่ไม่มีข้อมูลสำคัญ
    if (!goodId && !variantSku && !invItemId) return;
    
    // Col A: Good ID, Col B: Variant SKU, Col C: Inventory quantity, Col D: Inventory Item ID
    targetRows.push([goodId, variantSku, "", invItemId]);
  });
  
  // 4. เขียนข้อมูลลง Sheet "Inventory"
  let targetSheet = ss.getSheetByName(INVENTORY_CONFIG.TARGET_SHEET_NAME);
  if (!targetSheet) {
    targetSheet = ss.insertSheet(INVENTORY_CONFIG.TARGET_SHEET_NAME);
  } else {
    targetSheet.clear(); // เคลียร์เนื้อหาและรูปแบบเดิม
  }
  
  const numRows = targetRows.length;
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
  }
  
  targetSheet.getRange(1, 1, numRows, numCols).setValues(targetRows);
  targetSheet.getRange(1, 1, 1, numCols).setFontWeight("bold");
  targetSheet.setFrozenRows(1);
  
  const successMsg = `✅ ดึงข้อมูลสำเร็จ ${numRows - 1} รายการ ลงใน Sheet "${INVENTORY_CONFIG.TARGET_SHEET_NAME}"`;
  Logger.log(successMsg);
  writeInventoryLog_(INVENTORY_CONFIG.TARGET_SHEET_NAME, rows.length, numRows - 1, 0, successMsg);
}

// ============================================================
// MAIN FUNCTION 2: ใส่สูตร IMPORTRANGE อัตโนมัติใน Sheet "Inventory"
// ============================================================
/**
 * ใส่สูตร IMPORTRANGE ดึงข้อมูลสดอัตโนมัติจากไฟล์ "Products Export"
 */
function applyImportRangeFormulas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let targetSheet = ss.getSheetByName(INVENTORY_CONFIG.TARGET_SHEET_NAME);
  
  if (!targetSheet) {
    targetSheet = ss.insertSheet(INVENTORY_CONFIG.TARGET_SHEET_NAME);
  } else {
    targetSheet.clear();
  }
  
  const headers = ["Good ID", "Variant SKU", "Inventory quantity", "Inventory Item ID"];
  targetSheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
  targetSheet.setFrozenRows(1);
  
  const sourceId = INVENTORY_CONFIG.SOURCE_SPREADSHEET_ID;
  
  // สูตร IMPORTRANGE สำหรับ Good ID (Col A)
  targetSheet.getRange("A2").setFormula(`=IMPORTRANGE("${sourceId}", "Products Export!A2:A")`);
  
  // สูตร IMPORTRANGE สำหรับ Variant SKU (Col B)
  targetSheet.getRange("B2").setFormula(`=IMPORTRANGE("${sourceId}", "Products Export!B2:B")`);
  
  // สูตร IMPORTRANGE สำหรับ Inventory Item ID (Col D)
  targetSheet.getRange("D2").setFormula(`=IMPORTRANGE("${sourceId}", "Products Export!E2:E")`);
  
  Logger.log("✅ ใส่สูตร IMPORTRANGE ในคอลัมน์ A, B, D เรียบร้อยแล้ว");
  writeInventoryLog_(INVENTORY_CONFIG.TARGET_SHEET_NAME, 0, 0, 0, "ใส่สูตร IMPORTRANGE อัตโนมัติเรียบร้อยแล้ว");
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================
function findColIdx_(headers, candidates) {
  for (let i = 0; i < headers.length; i++) {
    for (let j = 0; j < candidates.length; j++) {
      if (headers[i].toLowerCase() === candidates[j].toLowerCase()) return i;
    }
  }
  return -1;
}

function writeInventoryLog_(targetSheetName, totalItems, successCount, failedCount, statusMsg) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let logSheet = ss.getSheetByName(INVENTORY_CONFIG.LOG_SHEET_NAME);
    if (!logSheet) {
      logSheet = ss.insertSheet(INVENTORY_CONFIG.LOG_SHEET_NAME);
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
