// ============================================================
// SYNCHRONOUS AUTO UPDATE TRIGGER FOR SHOPIFY PRICE PROCESS
// ============================================================

/**
 * ฟังก์ชั่นหลักสำหรับตั้งค่า Time-driven Trigger ใน Google Apps Script
 * ลำดับการทำงาน (Sequential Steps):
 *   1. getInventoryFromProductsExport() (ดึงข้อมูล Web Stock / Products Export)
 *   2. splitPriceSparepart()             (แยกราคาอะไหล่ลงชีต update_with_discount / update_no_discount)
 *   3. updateAllPricesBulkMutation()    (อัปเดตราคาขึ้น Shopify ด้วย Bulk Operation API)
 */
function runSynchronousPriceUpdate() {
  const startTime = Date.now();
  Logger.log("============================================================");
  Logger.log("🚀 เริ่มต้นกระบวนการ Synchronous Price Auto Update");
  Logger.log("============================================================");

  try {
    // ------------------------------------------------------------
    // STEP 1: ดึงข้อมูลจาก Web Stock / Products Export
    // ------------------------------------------------------------
    Logger.log("📍 [STEP 1/3] กำลังดึงข้อมูล Stock (getInventoryFromProductsExport)...");
    if (typeof getInventoryFromProductsExport === "function") {
      getInventoryFromProductsExport();
    } else if (typeof getDataFromWebStock === "function") {
      getDataFromWebStock();
    } else {
      Logger.log("⚠️ ไม่พบฟังก์ชั่น getInventoryFromProductsExport() กำลังข้ามไป Step 2");
    }
    SpreadsheetApp.flush(); // บังคับเขียนข้อมูลลง Sheet ทันที
    Utilities.sleep(1000);

    // ------------------------------------------------------------
    // STEP 2: แยกราคาอะไหล่ (Split Sparepart Prices)
    // ------------------------------------------------------------
    Logger.log("📍 [STEP 2/3] กำลังประมวลผลแยกราคาอะไหล่ (splitPriceSparepart)...");
    if (typeof splitPriceSparepart === "function") {
      splitPriceSparepart();
    } else {
      throw new Error("ไม่พบฟังก์ชั่น splitPriceSparepart()");
    }
    
    // บังคับคำนวณสูตร (VLOOKUP / IMPORTRANGE) ใน Sheet ให้เสร็จสมบูรณ์ก่อนอ่านค่าไปส่ง Shopify
    SpreadsheetApp.flush();
    Logger.log("⏳ รอระบบคำนวณสูตรใน Google Sheets...");
    Utilities.sleep(3000); // รอ 3 วินาทีให้สูตรคำนวณค่าเรียบร้อย

    // ------------------------------------------------------------
    // STEP 3: อัปเดตราคาแบบ Bulk Mutation ขึ้น Shopify
    // ------------------------------------------------------------
    Logger.log("📍 [STEP 3/3] กำลังส่งคำสั่งอัปเดตราคาแบบ Bulk ขึ้น Shopify (updateAllPricesBulkMutation)...");
    if (typeof updateAllPricesBulkMutation === "function") {
      updateAllPricesBulkMutation();
    } else {
      throw new Error("ไม่พบฟังก์ชั่น updateAllPricesBulkMutation()");
    }

    const durationSec = Math.round((Date.now() - startTime) / 1000);
    Logger.log("============================================================");
    Logger.log(`✅ กระบวนการ Synchronous Price Auto Update เสร็จสมบูรณ์แล้ว! (ใช้เวลาทั้งสิ้น ${durationSec} วินาที)`);
    Logger.log("============================================================");

  } catch (err) {
    Logger.log("============================================================");
    Logger.log("❌ เกิดข้อผิดพลาดในกระบวนการ Synchronous Auto Update: " + err.message);
    if (err.stack) Logger.log(err.stack);
    Logger.log("============================================================");
    
    // บันทึก Log ข้อผิดพลาดลง Sheet Log run script
    writeSynchronousLog_("Synchronous Auto Update Trigger", 0, 0, 0, "❌ Error: " + err.message);
  }
}

// Helper & Alias Functions
function getDataFromWebStock() {
  if (typeof getInventoryFromProductsExport === "function") {
    return getInventoryFromProductsExport();
  }
}

function get_data_form_web_stock() {
  return runSynchronousPriceUpdate();
}

/**
 * บันทึก Log การรัน Synchronous Update ลง Sheet "Log run script"
 */
function writeSynchronousLog_(targetName, totalItems, successCount, failedCount, statusMsg) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let logSheet = ss.getSheetByName("Log run script");
    if (!logSheet) {
      logSheet = ss.insertSheet("Log run script");
      const headers = ["Timestamp", "Target Sheet", "Total Items", "Success", "Failed / Skipped", "Status Message"];
      logSheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
      logSheet.setFrozenRows(1);
    }
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT+7", "yyyy-MM-dd HH:mm:ss");
    logSheet.appendRow([timestamp, targetName, totalItems, successCount, failedCount, statusMsg || "Completed"]);
  } catch (e) {
    Logger.log("⚠️ ไม่สามารถบันทึก Log ได้: " + e);
  }
}

// ============================================================
// INVENTORY SEQUENTIAL RUNNER (Run 3 files in order)
// ============================================================
/**
 * ฟังก์ชันรัน 3 ไฟล์ตามลำดับ (Sequential Execution)
 * ลำดับการทำงาน:
 *   1. get_inventory_web_export.gs (updateInventoryWebApiChunked) -> ดึงข้อมูลลง 'inventory web'
 *   2. get_inventory_web_stock_new.gs (syncInventorySheet)         -> ประมวลผลและเตรียมข้อมูลลง 'Inventory'
 *   3. update_inventory.gs (updateInventoryBulkMutation)          -> อัปเดตสต็อกขึ้น Shopify
 */
function runInventorySequentialProcess() {
  const startTime = Date.now();
  Logger.log("============================================================");
  Logger.log("🚀 เริ่มต้นรันกระบวนการ Inventory 3 ขั้นตอนตามลำดับ");
  Logger.log("============================================================");

  try {
    // ------------------------------------------------------------
    // STEP 1: get_inventory_web_export.gs
    // ------------------------------------------------------------
    Logger.log("📍 [STEP 1/3] กำลังรัน get_inventory_web_export.gs (updateInventoryWebApiChunked)...");
    if (typeof updateInventoryWebApiChunked === "function") {
      updateInventoryWebApiChunked();
    } else {
      throw new Error("ไม่พบฟังก์ชัน updateInventoryWebApiChunked() ใน get_inventory_web_export.gs");
    }
    
    SpreadsheetApp.flush(); // บังคับให้เขียนข้อมูลลง Sheet ทันที
    Logger.log("⏳ รอข้อมูลเขียนลง Sheet 'inventory web' เรียบร้อย...");
    Utilities.sleep(2000);

    // ------------------------------------------------------------
    // STEP 2: get_inventory_web_stock_new.gs
    // ------------------------------------------------------------
    Logger.log("📍 [STEP 2/3] กำลังรัน get_inventory_web_stock_new.gs (syncInventorySheet)...");
    if (typeof syncInventorySheet === "function") {
      syncInventorySheet();
    } else {
      throw new Error("ไม่พบฟังก์ชัน syncInventorySheet() ใน get_inventory_web_stock_new.gs");
    }

    SpreadsheetApp.flush(); // บังคับให้เขียนข้อมูลลง Sheet ทันที
    Logger.log("⏳ รอคำนวณและเขียนข้อมูลลง Sheet 'Inventory' เรียบร้อย...");
    Utilities.sleep(3000);

    // ------------------------------------------------------------
    // STEP 3: update_inventory.gs
    // ------------------------------------------------------------
    Logger.log("📍 [STEP 3/3] กำลังรัน update_inventory.gs (updateInventoryBulkMutation)...");
    if (typeof updateInventoryBulkMutation === "function") {
      updateInventoryBulkMutation();
    } else {
      throw new Error("ไม่พบฟังก์ชัน updateInventoryBulkMutation() ใน update_inventory.gs");
    }

    const durationSec = Math.round((Date.now() - startTime) / 1000);
    Logger.log("============================================================");
    Logger.log(`✅ ทำงานครบทั้ง 3 ขั้นตอนเสร็จสมบูรณ์! (ใช้เวลาทั้งสิ้น ${durationSec} วินาที)`);
    Logger.log("============================================================");

  } catch (err) {
    Logger.log("============================================================");
    Logger.log("❌ เกิดข้อผิดพลาดในกระบวนการ: " + err.message);
    if (err.stack) Logger.log(err.stack);
    Logger.log("============================================================");
    throw err;
  }
}
