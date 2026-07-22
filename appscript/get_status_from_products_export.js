// ============================================================
// CONFIG & CONSTANTS (Scoped object to prevent clashes with other gs files)
// ============================================================
var STATUS_EXPORT_CONFIG = {
  // Spreadsheet ID ของไฟล์ "รายการสินค้าทั้งหมดบนเว็บไซต์ active web sevenfive"
  SOURCE_SPREADSHEET_ID: "1hfHjhC7WdjVDT7qHt19PL8AnxlhTJ6rbbh-N4UBQJBA",
  SOURCE_SHEET_NAME: "Products Export",
  TARGET_SHEET_NAME: "Active Products",
  LOG_SHEET_NAME: "Log run script"
};

// ============================================================
// UI MENU
// ============================================================
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('📦 Product Status Tools')
    .addItem('1. ดึงเฉพาะสินค้าสถานะ Active จาก Products Export', 'getStatusFromProductsExport')
    .addToUi();
}

// ============================================================
// MAIN FUNCTION: ดึงข้อมูลเฉพาะสินค้าสถานะ ACTIVE
// ============================================================
/**
 * ดึงข้อมูล custom.good_id, Variant SKU, Product GID, Variant GID, status
 * จาก Sheet "Products Export" โดยคัดกรองเอาเฉพาะสินค้าที่มี status = ACTIVE เท่านั้น
 */
function getStatusFromProductsExport() {
  Logger.log("=== เริ่มดึงข้อมูลสินค้าเฉพาะสถานะ ACTIVE จาก Products Export ===");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. หา Sheet ต้นทาง (พยายามหาในไฟล์ปัจจุบันก่อน ถ้าไม่มีให้เปิดจาก SOURCE_SPREADSHEET_ID)
  let sourceSheet = ss.getSheetByName(STATUS_EXPORT_CONFIG.SOURCE_SHEET_NAME);
  if (!sourceSheet) {
    try {
      const sourceSS = SpreadsheetApp.openById(STATUS_EXPORT_CONFIG.SOURCE_SPREADSHEET_ID);
      sourceSheet = sourceSS.getSheetByName(STATUS_EXPORT_CONFIG.SOURCE_SHEET_NAME);
    } catch (e) {
      Logger.log("❌ ไม่สามารถเปิดไฟล์ต้นทางได้: " + e);
      writeStatusLog_("Active Products Fetch", 0, 0, 0, "❌ ไม่สามารถเปิดไฟล์ต้นทาง ID " + STATUS_EXPORT_CONFIG.SOURCE_SPREADSHEET_ID);
      return;
    }
  }
  
  if (!sourceSheet) {
    const errMsg = `❌ ไม่พบ Sheet "${STATUS_EXPORT_CONFIG.SOURCE_SHEET_NAME}" ในไฟล์ต้นทาง`;
    Logger.log(errMsg);
    writeStatusLog_("Active Products Fetch", 0, 0, 0, errMsg);
    return;
  }
  
  const lastRow = sourceSheet.getLastRow();
  const lastCol = sourceSheet.getLastColumn();
  
  if (lastRow < 2) {
    const warnMsg = `⚠️ ไม่พบข้อมูลใน Sheet "${STATUS_EXPORT_CONFIG.SOURCE_SHEET_NAME}"`;
    Logger.log(warnMsg);
    writeStatusLog_("Active Products Fetch", 0, 0, 0, warnMsg);
    return;
  }
  
  // 2. อ่านข้อมูลทั้งหมดจากต้นทาง
  const data = sourceSheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = data[0].map(h => String(h).trim());
  const rows = data.slice(1);
  
  // ค้นหาตำแหน่งคอลัมน์จาก Header
  const goodIdIdx = findColIdx_(headers, ["custom.good_id", "Good ID", "GoodID"]);
  const variantSkuIdx = findColIdx_(headers, ["Variant SKU", "VariantSKU", "SKU"]);
  const productGidIdx = findColIdx_(headers, ["Product GID", "ProductGID", "product_gid"]);
  const variantGidIdx = findColIdx_(headers, ["Variant GID", "VariantGID", "variant_gid"]);
  const statusIdx = findColIdx_(headers, ["Status", "status", "สถานะ"]);
  
  // ตำแหน่งคอลัมน์มาตรฐาน (Default: A = custom.good_id (0), B = Variant SKU (1), C = Product GID (2), D = Variant GID (3), L = Status (11))
  const colGoodId = goodIdIdx !== -1 ? goodIdIdx : 0;
  const colVariantSku = variantSkuIdx !== -1 ? variantSkuIdx : 1;
  const colProductGid = productGidIdx !== -1 ? productGidIdx : 2;
  const colVariantGid = variantGidIdx !== -1 ? variantGidIdx : 3;
  const colStatus = statusIdx !== -1 ? statusIdx : 11;
  
  // 3. กรองข้อมูลเอาเฉพาะ status = "ACTIVE"
  const targetHeaders = ["custom.good_id", "Variant SKU", "Product GID", "Variant GID", "status"];
  const activeRows = [targetHeaders];
  let totalActive = 0;
  let totalSkipped = 0;
  
  rows.forEach(row => {
    const statusVal = String(row[colStatus] || "").trim().toUpperCase();
    
    // ตรวจสอบว่าเป็น ACTIVE หรือไม่ (รองรับ ACTIVE หรือ true)
    if (statusVal === "ACTIVE" || statusVal === "TRUE") {
      const goodId = row[colGoodId] != null ? row[colGoodId] : "";
      const variantSku = row[colVariantSku] != null ? row[colVariantSku] : "";
      const productGid = row[colProductGid] != null ? row[colProductGid] : "";
      const variantGid = row[colVariantGid] != null ? row[colVariantGid] : "";
      
      activeRows.push([goodId, variantSku, productGid, variantGid, "ACTIVE"]);
      totalActive++;
    } else {
      totalSkipped++;
    }
  });
  
  Logger.log(`📊 พบสินค้าสถานะ ACTIVE ทั้งหมด: ${totalActive} รายการ (ข้ามสินค้าที่ไม่ใช่ Active: ${totalSkipped} รายการ)`);
  
  // 4. เขียนข้อมูลลง Sheet ปลายทาง "Active Products"
  let targetSheet = ss.getSheetByName(STATUS_EXPORT_CONFIG.TARGET_SHEET_NAME);
  if (!targetSheet) {
    targetSheet = ss.insertSheet(STATUS_EXPORT_CONFIG.TARGET_SHEET_NAME);
  } else {
    targetSheet.clear(); // เคลียร์เนื้อหาและรูปแบบเดิม
  }
  
  const numRows = activeRows.length;
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
  
  targetSheet.getRange(1, 1, numRows, numCols).setValues(activeRows);
  targetSheet.getRange(1, 1, 1, numCols).setFontWeight("bold");
  targetSheet.setFrozenRows(1);
  
  const successMsg = `✅ ดึงข้อมูลสินค้า Active สำเร็จ ${totalActive} รายการ ลงใน Sheet "${STATUS_EXPORT_CONFIG.TARGET_SHEET_NAME}"`;
  Logger.log(successMsg);
  writeStatusLog_(STATUS_EXPORT_CONFIG.TARGET_SHEET_NAME, rows.length, totalActive, totalSkipped, successMsg);
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
