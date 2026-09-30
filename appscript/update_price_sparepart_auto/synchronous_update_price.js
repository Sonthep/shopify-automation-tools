// ============================================================
// SYNCHRONOUS AUTO UPDATE TRIGGER FOR SHOPIFY PRICE PROCESS
// ============================================================

/**
 * ฟังก์ชั่นหลักสำหรับตั้งค่า Time-driven Trigger ใน Google Apps Script
 * ลำดับการทำงาน (Sequential Steps):
 *   1. syncPriceWebsiteFromShopify() (ดึงข้อมูล Web Stock จาก Shopify ลงชีต price website)
 *   2. importColumnsBIK()              (get_inventory_web_stock_new.gs ดึงข้อมูลลงชีต Spare Parts1)
 *   3. splitPriceSparepart()             (แยกราคาอะไหล่ลงชีต update_with_discount / update_no_discount)
 *   4. updateAllPricesBulkMutation()    (อัปเดตราคาขึ้น Shopify ด้วย Bulk Operation API)
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
    Logger.log("📍 [STEP 1/4] กำลังดึงข้อมูล Price Website จาก Shopify (syncPriceWebsiteFromShopify)...");
    if (typeof syncPriceWebsiteFromShopify === "function") {
      syncPriceWebsiteFromShopify();
    } else {
      Logger.log("⚠️ ไม่พบฟังก์ชั่น syncPriceWebsiteFromShopify() กำลังข้ามไป Step 2");
    }
    SpreadsheetApp.flush(); // บังคับเขียนข้อมูลลง Sheet ทันที
    Utilities.sleep(1000);

    // ------------------------------------------------------------
    // STEP 2: ดึงข้อมูลลงชีต Spare Parts1 (get_inventory_web_stock_new.gs)
    // ------------------------------------------------------------
    Logger.log("📍 [STEP 2/4] กำลังดึงข้อมูลลงชีต Spare Parts1 (importColumnsBIK)...");
    if (typeof importColumnsBIK === "function") {
      importColumnsBIK();
    } else {
      throw new Error("ไม่พบฟังก์ชั่น importColumnsBIK() ใน get_inventory_web_stock_new.gs");
    }
    SpreadsheetApp.flush();
    Utilities.sleep(1000);

    // ------------------------------------------------------------
    // STEP 3: แยกราคาอะไหล่ (Split Sparepart Prices)
    // ------------------------------------------------------------
    Logger.log("📍 [STEP 3/4] กำลังประมวลผลแยกราคาอะไหล่ (splitPriceSparepart)...");
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
    // STEP 4: อัปเดตราคาแบบ Bulk Mutation ขึ้น Shopify
    // ------------------------------------------------------------
    Logger.log("📍 [STEP 4/4] กำลังส่งคำสั่งอัปเดตราคาแบบ Bulk ขึ้น Shopify (updateAllPricesBulkMutation)...");
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
  if (typeof syncPriceWebsiteFromShopify === "function") {
    return syncPriceWebsiteFromShopify();
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
