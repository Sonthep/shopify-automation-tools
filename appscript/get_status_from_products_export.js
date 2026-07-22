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
    .addItem('2. ดึงเฉพาะสินค้าสถานะ Inactive จาก Products Export', 'getInactiveStatusFromProductsExport')
    .addToUi();
}

// ============================================================
// MAIN FUNCTIONS
// ============================================================

/**
 * ดึงเฉพาะสินค้าสถานะ ACTIVE
 */
function getStatusFromProductsExport() {
  processStatusFilter_("ACTIVE", STATUS_EXPORT_CONFIG.TARGET_SHEET_NAME || "Active Products");
}

/**
 * ดึงเฉพาะสินค้าสถานะ INACTIVE / DRAFT / ARCHIVED
 */
function getInactiveStatusFromProductsExport() {
  processStatusFilter_("INACTIVE", "Inactive");
}

// ============================================================
// CORE PROCESSING LOGIC (Fast Range Fetching & Chunk Writing)
// ============================================================

function processStatusFilter_(targetStatusMode, targetSheetName) {
  Logger.log(`=== เริ่มดึงข้อมูลสินค้าสถานะ [${targetStatusMode}] จาก Products Export ===`);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. เปิด Sheet ต้นทาง
  let sourceSheet = ss.getSheetByName(STATUS_EXPORT_CONFIG.SOURCE_SHEET_NAME);
  if (!sourceSheet) {
    try {
      const sourceSS = SpreadsheetApp.openById(STATUS_EXPORT_CONFIG.SOURCE_SPREADSHEET_ID);
      sourceSheet = sourceSS.getSheetByName(STATUS_EXPORT_CONFIG.SOURCE_SHEET_NAME);
    } catch (e) {
      Logger.log("❌ ไม่สามารถเปิดไฟล์ต้นทางได้: " + e);
      writeStatusLog_("Status Fetch", 0, 0, 0, "❌ ไม่สามารถเปิดไฟล์ต้นทาง ID " + STATUS_EXPORT_CONFIG.SOURCE_SPREADSHEET_ID);
      return;
    }
  }
  
  if (!sourceSheet) {
    const errMsg = `❌ ไม่พบ Sheet "${STATUS_EXPORT_CONFIG.SOURCE_SHEET_NAME}" ในไฟล์ต้นทาง`;
    Logger.log(errMsg);
    writeStatusLog_("Status Fetch", 0, 0, 0, errMsg);
    return;
  }
  
  const lastRow = sourceSheet.getLastRow();
  const lastCol = sourceSheet.getLastColumn();
  
  if (lastRow < 2) {
    const warnMsg = `⚠️ ไม่พบข้อมูลใน Sheet "${STATUS_EXPORT_CONFIG.SOURCE_SHEET_NAME}"`;
    Logger.log(warnMsg);
    writeStatusLog_("Status Fetch", 0, 0, 0, warnMsg);
    return;
  }
  
  // 2. อ่านเฉพาะ Row 1 เพื่อหาตำแหน่งคอลัมน์ (ใช้เวลาน้อยกว่า 0.1 วินาที)
  const headerRow = sourceSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  
  const goodIdIdx = findColIdx_(headerRow, ["custom.good_id", "Good ID", "GoodID"]);
  const variantSkuIdx = findColIdx_(headerRow, ["Variant SKU", "VariantSKU", "SKU"]);
  const productGidIdx = findColIdx_(headerRow, ["Product GID", "ProductGID", "product_gid"]);
  const variantGidIdx = findColIdx_(headerRow, ["Variant GID", "VariantGID", "variant_gid"]);
  const statusIdx = findColIdx_(headerRow, ["Status", "status", "สถานะ"]);
  
  const colGoodId = goodIdIdx !== -1 ? goodIdIdx + 1 : 1;       // Default Col A (1)
  const colVariantSku = variantSkuIdx !== -1 ? variantSkuIdx + 1 : 2; // Default Col B (2)
  const colProductGid = productGidIdx !== -1 ? productGidIdx + 1 : 3; // Default Col C (3)
  const colVariantGid = variantGidIdx !== -1 ? variantGidIdx + 1 : 4; // Default Col D (4)
  const colStatus = statusIdx !== -1 ? statusIdx + 1 : 12;      // Default Col L (12)
  
  Logger.log(`📌 ดึงข้อมูลเฉพาะคอลัมน์ ID/SKU (Col 1-4) และ Status (Col ${colStatus}) - ข้ามคอลัมน์ HTML หนักๆ`);
  
  // 3. ดึงเฉพาะ 2 ช่วงข้อมูล: คอลัมน์ A-D (1-4) และ คอลัมน์ Status (12)
  const idSkuData = sourceSheet.getRange(2, 1, lastRow - 1, 4).getValues();
  const statusData = sourceSheet.getRange(2, colStatus, lastRow - 1, 1).getValues();
  
  const targetHeaders = ["custom.good_id", "Variant SKU", "Product GID", "Variant GID", "status"];
  const matchedRows = [targetHeaders];
  let totalMatch = 0;
  let totalSkipped = 0;
  
  const targetModeUpper = targetStatusMode.toUpperCase();
  
  for (let i = 0; i < idSkuData.length; i++) {
    const rowId = idSkuData[i];
    const statusVal = String(statusData[i][0] || "").trim().toUpperCase();
    
    let isMatch = false;
    if (targetModeUpper === "ACTIVE") {
      isMatch = (statusVal === "ACTIVE" || statusVal === "TRUE");
    } else {
      isMatch = (statusVal !== "ACTIVE" && statusVal !== "TRUE");
    }
    
    if (isMatch) {
      const goodId = rowId[0] != null ? rowId[0] : "";
      const variantSku = rowId[1] != null ? rowId[1] : "";
      const productGid = rowId[2] != null ? rowId[2] : "";
      const variantGid = rowId[3] != null ? rowId[3] : "";
      
      matchedRows.push([goodId, variantSku, productGid, variantGid, statusVal || targetModeUpper]);
      totalMatch++;
    } else {
      totalSkipped++;
    }
  }
  
  Logger.log(`📊 ประมวลผลเสร็จสิ้น! พบสินค้าสถานะ [${targetStatusMode}]: ${totalMatch} รายการ (ข้าม ${totalSkipped} รายการ)`);
  
  // 4. เขียนข้อมูลลง Sheet ปลายทาง
  let targetSheet = ss.getSheetByName(targetSheetName);
  if (!targetSheet) {
    targetSheet = ss.insertSheet(targetSheetName);
  } else {
    targetSheet.clear();
  }
  
  const numRows = matchedRows.length;
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
  } else if (currentRows > numRows) {
    targetSheet.deleteRows(numRows + 1, currentRows - numRows);
  }
  
  // เขียนข้อมูลแบบแบ่ง Chunk ละ 5,000 แถว ป้องกัน Apps Script RPC Payload Lock (Exception: Document is missing)
  const WRITE_CHUNK_SIZE = 5000;
  for (let i = 0; i < numRows; i += WRITE_CHUNK_SIZE) {
    const chunk = matchedRows.slice(i, i + WRITE_CHUNK_SIZE);
    targetSheet.getRange(i + 1, 1, chunk.length, numCols).setValues(chunk);
  }
  
  targetSheet.getRange(1, 1, 1, numCols).setFontWeight("bold");
  targetSheet.setFrozenRows(1);
  
  const successMsg = `✅ ดึงข้อมูลสินค้าสถานะ ${targetStatusMode} สำเร็จ ${totalMatch} รายการ ลงใน Sheet "${targetSheetName}"`;
  Logger.log(successMsg);
  writeStatusLog_(targetSheetName, idSkuData.length, totalMatch, totalSkipped, successMsg);
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
