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
    .addItem('1. ใส่สูตรดึงสินค้า Active (เร็วที่สุดใน 1 วินาที)', 'getActiveProductsViaQuery')
    .addItem('2. ใส่สูตรดึงสินค้า Inactive (เร็วที่สุดใน 1 วินาที)', 'getInactiveProductsViaQuery')
    .addSeparator()
    .addItem('3. แปลงสูตรใน Sheet ปัจจุบันเป็นข้อความปกติ (Freeze Values)', 'convertFormulasToValues')
    .addToUi();
}

// ============================================================
// MAIN FUNCTIONS
// ============================================================

/**
 * ดึงสินค้าสถานะ ACTIVE (ฟังก์ชั่นเดิมเพื่อรองรับการเรียกใช้)
 */
function getStatusFromProductsExport() {
  getActiveProductsViaQuery();
}

/**
 * ดึงสินค้าสถานะ INACTIVE (ฟังก์ชั่นเดิมเพื่อรองรับการเรียกใช้)
 */
function getInactiveStatusFromProductsExport() {
  getInactiveProductsViaQuery();
}

/**
 * ดึงสินค้าสถานะ ACTIVE ด้วยสูตร QUERY(IMPORTRANGE) ทำงานเสร็จใน 1 วินาที!
 */
function getActiveProductsViaQuery() {
  applyQueryFormula_("Active Products", "WHERE Upper(Col12) = 'ACTIVE'");
}

/**
 * ดึงสินค้าสถานะ INACTIVE / DRAFT ด้วยสูตร QUERY(IMPORTRANGE) ทำงานเสร็จใน 1 วินาที!
 */
function getInactiveProductsViaQuery() {
  applyQueryFormula_("Inactive", "WHERE Upper(Col12) <> 'ACTIVE'");
}

/**
 * ใส่สูตร QUERY + IMPORTRANGE ในเซลล์ A1 ของ Sheet ที่กำหนด
 */
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
  
  // สูตร QUERY IMPORTRANGE ดึง Col 1(custom.good_id), Col 2(Variant SKU), Col 3(Product GID), Col 4(Variant GID), Col 12(Status)
  const formula = `=QUERY(IMPORTRANGE("${sourceId}", "${sourceSheetName}!A:L"), "SELECT Col1, Col2, Col3, Col4, Col12 ${whereClause}", 1)`;
  
  targetSheet.getRange("A1").setFormula(formula);
  SpreadsheetApp.flush();
  
  Logger.log(`✅ ใส่สูตรลงใน Sheet "${targetSheetName}" เซลล์ A1 เรียบร้อยแล้ว!`);
}

/**
 * แปลงสูตรใน Sheet ปัจจุบันเป็นค่าข้อความปกติ (เพื่อไม่ให้สูตรคำนวณซ้ำ)
 */
function convertFormulasToValues() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  const range = sheet.getDataRange();
  range.setValues(range.getValues());
  Logger.log("✅ แปลงสูตรใน Sheet " + sheet.getName() + " เป็นค่าข้อความปกติเรียบร้อยแล้ว");
}
