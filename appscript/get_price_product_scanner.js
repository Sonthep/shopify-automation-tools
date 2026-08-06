// ============================================================
// GET PRICE PRODUCT SCANNER (FAST JAVASCRIPT HASH MAP)
// Source: Spreadsheet '1RlC-pWveUFehlqqqL1KXUOW9_DaPhJS6MPp-iiiaEZY' (Sheet: Warehouse_stock)
// Target: Active Spreadsheet (Sheet: Products2)
// ============================================================

function getPriceProductScanner() {
  const SOURCE_SPREADSHEET_ID = "1RlC-pWveUFehlqqqL1KXUOW9_DaPhJS6MPp-iiiaEZY";
  const SOURCE_SHEET_NAME = "Warehouse_stock";
  const TARGET_SHEET_NAME = "Products2";

  Logger.log("🚀 Starting Price Update via JavaScript Hash Map...");

  // 1. ดึงข้อมูลจากไฟล์ต้นทาง (External Spreadsheet)
  let sourceSS;
  try {
    sourceSS = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID);
  } catch (e) {
    Logger.log("❌ ไม่สามารถเปิดไฟล์ต้นทางได้ ID: " + SOURCE_SPREADSHEET_ID + " (" + e.message + ")");
    return;
  }

  const sourceSheet = sourceSS.getSheetByName(SOURCE_SHEET_NAME);
  if (!sourceSheet) {
    Logger.log("❌ ไม่พบ Sheet ต้นทางชื่อ: " + SOURCE_SHEET_NAME);
    return;
  }

  const sourceData = sourceSheet.getDataRange().getValues();
  if (sourceData.length < 2) {
    Logger.log("⚠️ ชีตต้นทางไม่มีข้อมูล");
    return;
  }

  // หาตำแหน่งคอลัมน์จากแถว Header (Row 1) ของต้นทาง
  const sourceHeaders = sourceData[0].map(h => String(h).trim().toLowerCase());
  const srcGoodIdCol = sourceHeaders.indexOf("goodid") !== -1 ? sourceHeaders.indexOf("goodid") : 0;
  const srcPriceCol = sourceHeaders.indexOf("price") !== -1 ? sourceHeaders.indexOf("price") : 6;
  const srcVatCol = sourceHeaders.indexOf("price+vat") !== -1 ? sourceHeaders.indexOf("price+vat") : 7;

  Logger.log(`  Source Column Mapped -> GoodID: Col ${srcGoodIdCol + 1}, Price: Col ${srcPriceCol + 1}, Price+Vat: Col ${srcVatCol + 1}`);

  // 2. สร้าง JavaScript Hash Map ในความจำ (RAM) เพื่อการดึงข้อมูลความเร็ว O(1)
  const priceMap = {};
  for (let i = 1; i < sourceData.length; i++) {
    const row = sourceData[i];
    const rawId = row[srcGoodIdCol];
    if (rawId != null && rawId !== "") {
      const goodIdKey = String(parseInt(rawId, 10) || String(rawId).trim());
      priceMap[goodIdKey] = {
        price: row[srcPriceCol] != null ? row[srcPriceCol] : "",
        priceVat: row[srcVatCol] != null ? row[srcVatCol] : ""
      };
    }
  }

  const mappedKeysCount = Object.keys(priceMap).length;
  Logger.log(`✅ สร้าง Hash Map ในความจำสำเร็จ! รวม ${mappedKeysCount} รายการราคา`);

  // 3. ดึงข้อมูลจากชีตปลายทาง (Target Sheet: Products2)
  const targetSS = SpreadsheetApp.getActiveSpreadsheet();
  const targetSSId = targetSS.getId();
  let targetSheet = targetSS.getSheetByName(TARGET_SHEET_NAME);
  
  if (!targetSheet) {
    targetSheet = targetSS.getSheetByName("Products Export") || targetSS.getActiveSheet();
    Logger.log("⚠️ ไม่พบ Sheet '" + TARGET_SHEET_NAME + "' จึงใช้ Sheet '" + targetSheet.getName() + "' แทน");
  }

  const targetData = targetSheet.getDataRange().getValues();
  if (targetData.length < 2) {
    Logger.log("⚠️ ชีตปลายทางไม่มีแถวข้อมูลให้ข้ามไฟล์");
    return;
  }

  const targetHeaders = targetData[0].map(h => String(h).trim().toLowerCase());
  
  // หาตำแหน่งคอลัมน์ของชีตปลายทางโดยอัตโนมัติ
  let tgtGoodIdCol = targetHeaders.indexOf("custom.good_id");
  if (tgtGoodIdCol === -1) tgtGoodIdCol = targetHeaders.indexOf("goodid");
  if (tgtGoodIdCol === -1) tgtGoodIdCol = 0; // ค่าเริ่มต้น คอลัมน์ A

  let tgtPriceCol = targetHeaders.indexOf("price");
  if (tgtPriceCol === -1) tgtPriceCol = 3; // ค่าเริ่มต้น คอลัมน์ D

  let tgtVatCol = targetHeaders.indexOf("include vat 7%");
  if (tgtVatCol === -1) tgtVatCol = targetHeaders.indexOf("price+vat");
  if (tgtVatCol === -1) tgtVatCol = 4; // ค่าเริ่มต้น คอลัมน์ E

  Logger.log(`  Target Column Mapped -> GoodID: Col ${tgtGoodIdCol + 1}, Price: Col ${tgtPriceCol + 1}, Include VAT 7%: Col ${tgtVatCol + 1}`);

  // 4. แมปคู่อย่างรวดเร็วผ่าน Hash Map
  let updatedCount = 0;
  for (let i = 1; i < targetData.length; i++) {
    const rawTargetId = targetData[i][tgtGoodIdCol];
    if (rawTargetId != null && rawTargetId !== "") {
      const targetIdKey = String(parseInt(rawTargetId, 10) || String(rawTargetId).trim());
      const match = priceMap[targetIdKey];
      if (match) {
        targetData[i][tgtPriceCol] = match.price;
        targetData[i][tgtVatCol] = match.priceVat;
        updatedCount++;
      }
    }
  }

  // 5. เขียนผลลัพธ์ลงชีตปลายทางในคราวเดียว (Fast Bulk Write)
  let usedSheetsApi = false;
  if (typeof Sheets !== "undefined") {
    try {
      Sheets.Spreadsheets.Values.update(
        { values: targetData },
        targetSSId,
        `${targetSheet.getName()}!A1`,
        { valueInputOption: "RAW" }
      );
      usedSheetsApi = true;
    } catch (e) {
      // Fallback to setValues
    }
  }

  if (!usedSheetsApi) {
    targetSheet.getRange(1, 1, targetData.length, targetData[0].length).setValues(targetData);
    SpreadsheetApp.flush();
  }

  Logger.log(`🎉 สำเร็จ! จับคู่และอัปเดตราคาข้ามไฟล์เรียบร้อยรวม ${updatedCount} แถว ในชีต '${targetSheet.getName()}'`);
}
