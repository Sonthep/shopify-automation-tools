// ============================================================
// CONFIG & CONSTANTS (Scoped object to prevent clashes with other gs files)
// ============================================================
var STATUS_EXPORT_CONFIG = {
  SOURCE_SPREADSHEET_ID: "1hfHjhC7WdjVDT7qHt19PL8AnxlhTJ6rbbh-N4UBQJBA",
  SOURCE_SHEET_NAME: "Products Export",
  LOG_SHEET_NAME: "Log run script"
};

// ============================================================
// UI MENU
// ============================================================
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('📦 Product Status Tools')
    .addItem('🧪 1. ทดสอบดึงแค่ 10 แถวแรก (Direct Values - 1 วินาที)', 'test10RowsFromProductsExport')
    .addSeparator()
    .addItem('2. ดึงสินค้า Active ทั้งหมดด้วยสูตร QUERY (1 วินาที)', 'getActiveProductsViaQuery')
    .addItem('3. ดึงสินค้า Inactive ทั้งหมดด้วยสูตร QUERY (1 วินาที)', 'getInactiveProductsViaQuery')
    .addSeparator()
    .addItem('4. แปลงสูตรใน Sheet ปัจจุบันเป็นข้อความปกติ (Freeze Values)', 'convertFormulasToValues')
    .addToUi();
}

// ============================================================
// MAIN FUNCTION (ดึง 10 แถวแรกทันทีแบบ Direct Values)
// ============================================================

/**
 * ดึงสินค้าสถานะ ACTIVE 10 แถวแรกทันทีลงใน Sheet "Active Products"
 */
function getStatusFromProductsExport() {
  test10RowsFromProductsExport();
}

/**
 * ทดสอบดึงข้อมูลเฉพาะ 10 แถวแรกที่มีสถานะ ACTIVE จาก Products Export
 * อ่านข้อมูลเพียง 50 แถวแรกจากต้นทาง ทำให้ประมวลผลเสร็จใน 1 วินาที!
 */
function test10RowsFromProductsExport() {
  Logger.log("=== เริ่มทดสอบดึงข้อมูลเฉพาะ 10 แถวแรก (Direct Values) ===");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  let sourceSheet = ss.getSheetByName(STATUS_EXPORT_CONFIG.SOURCE_SHEET_NAME);
  if (!sourceSheet) {
    try {
      const sourceSS = SpreadsheetApp.openById(STATUS_EXPORT_CONFIG.SOURCE_SPREADSHEET_ID);
      sourceSheet = sourceSS.getSheetByName(STATUS_EXPORT_CONFIG.SOURCE_SHEET_NAME);
    } catch (e) {
      Logger.log("❌ ไม่สามารถเปิดไฟล์ต้นทางได้: " + e);
      return;
    }
  }
  
  if (!sourceSheet) {
    Logger.log("❌ ไม่พบ Sheet ในไฟล์ต้นทาง");
    return;
  }
  
  // อ่านเฉพาะ 50 แถวแรกจากต้นทางเพื่อคัดเลือก 10 แถวแรก (ทำงานเสร็จใน 1 วินาที!)
  const idSkuData = sourceSheet.getRange(2, 1, 50, 4).getValues();
  const statusData = sourceSheet.getRange(2, 12, 50, 1).getValues();
  
  const targetHeaders = ["custom.good_id", "Variant SKU", "Product GID", "Variant GID", "status"];
  const rows = [targetHeaders];
  let count = 0;
  
  for (let i = 0; i < idSkuData.length; i++) {
    const statusVal = String(statusData[i][0] || "").trim().toUpperCase();
    if (statusVal === "ACTIVE" || statusVal === "TRUE") {
      const rowId = idSkuData[i];
      rows.push([rowId[0], rowId[1], rowId[2], rowId[3], "ACTIVE"]);
      count++;
      if (count >= 10) break;
    }
  }
  
  let targetSheet = ss.getSheetByName("Active Products");
  if (!targetSheet) {
    targetSheet = ss.insertSheet("Active Products");
  } else {
    targetSheet.clear();
  }
  
  targetSheet.getRange(1, 1, rows.length, 5).setValues(rows);
  targetSheet.getRange(1, 1, 1, 5).setFontWeight("bold");
  targetSheet.setFrozenRows(1);
  
  Logger.log(`✅ [SUCCESS] ดึงข้อมูลทดสอบสำเร็จ ${count} รายการ เขียนลงใน Sheet "Active Products" เรียบร้อยแล้ว!`);
}

function getInactiveStatusFromProductsExport() {
  getInactiveProductsViaQuery();
}

function getActiveProductsViaQuery() {
  applyQueryFormula_("Active Products", "WHERE Upper(Col12) = 'ACTIVE'");
}

function getInactiveProductsViaQuery() {
  applyQueryFormula_("Inactive", "WHERE Upper(Col12) <> 'ACTIVE'");
}

function applyQueryFormula_(targetSheetName, whereClause) {
  Logger.log(`=== เริ่มใส่สูตร QUERY ดึงสินค้า [${targetSheetName}] ===`);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  let targetSheet = ss.getSheetByName(targetSheetName);
  if (!targetSheet) {
    targetSheet = ss.insertSheet(targetSheetName);
  } else {
    targetSheet.clear();
  }
  
  const sourceId = STATUS_EXPORT_CONFIG.SOURCE_SPREADSHEET_ID;
  const sourceSheetName = STATUS_EXPORT_CONFIG.SOURCE_SHEET_NAME;
  
  const formula = `=QUERY(IMPORTRANGE("${sourceId}", "${sourceSheetName}!A:L"), "SELECT Col1, Col2, Col3, Col4, Col12 ${whereClause}", 1)`;
  
  targetSheet.getRange("A1").setFormula(formula);
  SpreadsheetApp.flush();
  
  Logger.log(`✅ ใส่สูตรลงใน Sheet "${targetSheetName}" เซลล์ A1 เรียบร้อยแล้ว! (หากขึ้น #REF! ให้กด "อนุญาตการเข้าถึง" ที่เซลล์ A1)`);
}

function convertFormulasToValues() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  const range = sheet.getDataRange();
  range.setValues(range.getValues());
  Logger.log("✅ แปลงสูตรใน Sheet " + sheet.getName() + " เป็นค่าข้อความปกติเรียบร้อยแล้ว");
}
