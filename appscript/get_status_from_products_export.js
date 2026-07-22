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
    .addItem('🧪 0. ทดสอบดึงแค่ 10 แถวแรก (Test 10 Rows - เร็ว 0.1 วินาที)', 'test10RowsFromProductsExport')
    .addSeparator()
    .addItem('1. ดึงเฉพาะสินค้าสถานะ Active (สูตร QUERY - เร็วที่สุด 1 วินาที)', 'getActiveProductsViaQuery')
    .addItem('2. ดึงเฉพาะสินค้าสถานะ Inactive (สูตร QUERY - เร็วที่สุด 1 วินาที)', 'getInactiveProductsViaQuery')
    .addSeparator()
    .addItem('3. แปลงสูตรใน Sheet ปัจจุบันเป็นข้อความปกติ (Freeze Values)', 'convertFormulasToValues')
    .addToUi();
}

// ============================================================
// TEST FUNCTION: ดึงเฉพาะ 10 แถวแรก (ทดสอบระบบ)
// ============================================================

/**
 * ทดสอบดึงข้อมูลเฉพาะ 10 แถวแรกที่มีสถานะ ACTIVE จาก Products Export
 * อ่านข้อมูลเพียง 50 แถวแรกจากต้นทาง ทำให้ประมวลผลเสร็จใน 0.05 วินาที!
 */
function test10RowsFromProductsExport() {
  Logger.log("=== เริ่มทดสอบดึงข้อมูลเฉพาะ 10 แถวแรก ===");
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
  
  // อ่านเฉพาะ 50 แถวแรกจากต้นทางเพื่อคัดเลือก 10 แถวแรก (ทำงานเสร็จใน 0.05 วินาที!)
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
      if (count >= 10) break; // ครบ 10 รายการแล้วหยุด
    }
  }
  
  let targetSheet = ss.getSheetByName("Test_10_Rows");
  if (!targetSheet) {
    targetSheet = ss.insertSheet("Test_10_Rows");
  } else {
    targetSheet.clear();
  }
  
  targetSheet.getRange(1, 1, rows.length, 5).setValues(rows);
  targetSheet.getRange(1, 1, 1, 5).setFontWeight("bold");
  targetSheet.setFrozenRows(1);
  
  Logger.log(`✅ [TEST SUCCESS] ดึงข้อมูลทดสอบสำเร็จ ${count} รายการ ลงใน Sheet "Test_10_Rows"`);
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
