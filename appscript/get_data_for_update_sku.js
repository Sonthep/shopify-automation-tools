// ============================================================
// Script: get_data_for_update_sku
// ดึงข้อมูลจากไฟล์ Products Export มาลงชีต update_sku พร้อมแนบ winspeed sku
// ============================================================

function getDataForUpdateSku() {
  Logger.log("=== เริ่มดึงข้อมูลสำหรับ Update SKU ===");
  
  const SOURCE_FILE_ID = "1hfHjhC7WdjVDT7qHt19PL8AnxlhTJ6rbbh-N4UBQJBA";
  const SOURCE_SHEET_NAME = "Products Export";
  const TARGET_SHEET_NAME = "update_sku";
  
  try {
    // 1. เปิดไฟล์ต้นทาง (Products Export)
    const sourceSs = SpreadsheetApp.openById(SOURCE_FILE_ID);
    const sourceSheet = sourceSs.getSheetByName(SOURCE_SHEET_NAME);
    
    if (!sourceSheet) {
      throw new Error(`ไม่พบชีต "${SOURCE_SHEET_NAME}" ในไฟล์ต้นทาง (${SOURCE_FILE_ID})`);
    }
    
    // 2. ดึงข้อมูลจาก Winspeed (VLOOKUP Col B เอา Col C) จากชีต Active และ Inactive
    const winspeedMap = fetchWinspeedSkuMap_();
    
    // 3. อ่านข้อมูลทั้งหมดจากต้นทาง
    const sourceData = sourceSheet.getDataRange().getValues();
    if (sourceData.length < 2) {
      throw new Error("ไม่มีข้อมูลในชีตต้นทาง");
    }
    
    // 4. หา Index ของแต่ละคอลัมน์เป้าหมายจากหัวตาราง
    const headers = sourceData[0];
    const colIdx = {
      goodId: headers.indexOf("custom.good_id"),
      sku: headers.indexOf("Variant SKU"),
      productGid: headers.indexOf("Product GID"),
      variantGid: headers.indexOf("Variant GID")
    };
    
    const missingCols = [];
    if (colIdx.goodId === -1) missingCols.push("custom.good_id");
    if (colIdx.sku === -1) missingCols.push("Variant SKU");
    if (colIdx.productGid === -1) missingCols.push("Product GID");
    if (colIdx.variantGid === -1) missingCols.push("Variant GID");
    
    if (missingCols.length > 0) {
      throw new Error(`ไม่พบคอลัมน์: ${missingCols.join(", ")} ในไฟล์ต้นทาง`);
    }
    
    // 5. จัดเตรียมข้อมูลสำหรับเขียนลงชีตปลายทาง
    const targetHeaders = ["Good ID", "website sku", "winspeed sku", "check update", "Product GID", "Variant GID"];
    const targetRows = [targetHeaders];
    
    for (let i = 1; i < sourceData.length; i++) {
      const row = sourceData[i];
      const r = i + 1; // ลำดับแถวสำหรับใส่สูตร (เริ่มที่แถว 2)
      
      const goodId = String(row[colIdx.goodId] || "").trim();
      const websiteSku = String(row[colIdx.sku] || "").trim();
      
      // ข้ามถ้าเป็นแถวว่าง
      if (!goodId && !websiteSku) continue;
      
      const productGid = String(row[colIdx.productGid] || "").trim();
      const variantGid = String(row[colIdx.variantGid] || "").trim();
      
      // หา winspeed sku จาก map (Vlookup ด้วย Good ID)
      const winspeedSku = winspeedMap.get(goodId) || "";
      
      // สูตรเช็คข้อมูลเปรียบเทียบ website sku (B) กับ winspeed sku (C) 
      const checkFormula = `=B${r}=C${r}`; 
      
      targetRows.push([
        goodId,
        websiteSku,
        winspeedSku,
        checkFormula,
        productGid,
        variantGid
      ]);
    }
    
    // 6. เขียนข้อมูลลงไฟล์ปัจจุบัน (Active Spreadsheet)
    const targetSs = SpreadsheetApp.getActiveSpreadsheet();
    let targetSheet = targetSs.getSheetByName(TARGET_SHEET_NAME);
    
    if (!targetSheet) {
      targetSheet = targetSs.insertSheet(TARGET_SHEET_NAME);
    } else {
      targetSheet.clear(); 
    }
    
    const numRows = targetRows.length;
    const numCols = targetHeaders.length;
    
    targetSheet.getRange(1, 1, numRows, numCols).setValues(targetRows);
    targetSheet.getRange(1, 1, 1, numCols).setFontWeight("bold");
    targetSheet.setFrozenRows(1);
    
    const msg = `✅ ดึงข้อมูลอัปเดต SKU สำเร็จ ${numRows - 1} รายการ (พร้อม VLOOKUP Winspeed SKU)`;
    Logger.log(msg);
    SpreadsheetApp.getActive().toast(msg, "สำเร็จ", 5);
    
  } catch (error) {
    Logger.log("❌ Error: " + error.message);
    SpreadsheetApp.getActive().toast(error.message, "เกิดข้อผิดพลาด", 10);
  }
}

/**
 * ดึงข้อมูล Vlookup (Col B -> Col C) จากไฟล์ Winspeed
 */
function fetchWinspeedSkuMap_() {
  const map = new Map();
  const WINSPEED_FILE_ID = "1-7ap--3aphttTb8M0cXYvVYmRGtZQKRxoUW3nvwuUNA";
  
  try {
    const ws = SpreadsheetApp.openById(WINSPEED_FILE_ID);
    const sheetNames = ["Active", "Inactive"];
    
    sheetNames.forEach(sheetName => {
      const sheet = ws.getSheetByName(sheetName);
      if (sheet) {
        const lastRow = sheet.getLastRow();
        if (lastRow >= 2) {
          // ดึงคอลัมน์ B (GoodID) ถึง C (GoodCode) -> getRange(startRow, startCol, numRows, numCols)
          // B = 2, จำนวนคอลัมน์ B ถึง C = 2
          const values = sheet.getRange(2, 2, lastRow - 1, 2).getValues();
          
          for (let i = 0; i < values.length; i++) {
            const goodId = String(values[i][0] || "").trim(); // Col B
            const goodCode = String(values[i][1] || "").trim(); // Col C
            
            if (goodId && !map.has(goodId)) {
              map.set(goodId, goodCode);
            }
          }
        }
      }
    });
    Logger.log(`📌 สร้าง VLOOKUP Map สำเร็จ: ${map.size} รายการ`);
  } catch (e) {
    Logger.log(`⚠️ ไม่สามารถดึงข้อมูล VLOOKUP จาก Winspeed ได้: ${e.message}`);
  }
  return map;
}

// สร้างเมนูบนหน้า Sheet สำหรับเรียกใช้งานง่ายๆ
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📦 SKU Tools')
    .addItem('ดึงข้อมูลเตรียม Update SKU', 'getDataForUpdateSku')
    .addToUi();
}
