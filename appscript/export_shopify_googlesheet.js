// ============================================================
// CONFIG
// ============================================================
var SHOP = PropertiesService.getScriptProperties().getProperty("SHOP") || "sevenfive-4062.myshopify.com";
var CLIENT_ID = PropertiesService.getScriptProperties().getProperty("CLIENT_ID") || "YOUR_CLIENT_ID";
var CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("CLIENT_SECRET") || "YOUR_CLIENT_SECRET";

var EXPORT_SHEET_NAME = "Products Export";
var POLL_INTERVAL_MS = 10000; // เช็คสถานะทุกๆ 10 วินาที

// Keys สำหรับเก็บ Token ลง Properties
var PROP_ACCESS_TOKEN = "ACCESS_TOKEN";
var PROP_TOKEN_EXPIRY = "TOKEN_EXPIRY";
var PROP_LAST_BULK_OP_ID = "LAST_BULK_OP_ID";

// ============================================================
// UI MENU
// ============================================================
// function onOpen() {
//   const ui = SpreadsheetApp.getUi();
//   ui.createMenu('📦 Shopify Tools')
//     .addItem('1. Export Products to Sheet', 'exportProductsToSheet')
//     .addItem('2. Clean HTML in Sheet', 'cleanHtmlInSheet')
//     .addToUi();
// }

// ============================================================
// MAIN FUNCTION
// ============================================================
function exportProductsToSheet() {
  const props = PropertiesService.getScriptProperties();
  let opId = props.getProperty(PROP_LAST_BULK_OP_ID);
  
  // เช็คสถานะปัจจุบันของ Bulk Operation บน Shopify ก่อนเสมอ
  Logger.log("Checking current bulk operation status on Shopify...");
  const checkQuery = `{ currentBulkOperation(type: QUERY) { id status url } }`;
  const checkRes = callGraphQL_({ query: checkQuery });
  const currentOp = (checkRes && checkRes.data) ? checkRes.data.currentBulkOperation : null;
  
  // 1. ถ้ามี Bulk Query ที่เตรียมเสร็จเรียบร้อยแล้ว (COMPLETED) ให้ดาวน์โหลดได้ทันที โดยไม่ต้องสั่งทำใหม่
  if (currentOp && currentOp.status === "COMPLETED" && currentOp.url) {
    Logger.log("Found completed bulk operation: " + currentOp.id);
    downloadAndProcessJSONL_(currentOp.url);
    props.deleteProperty(PROP_LAST_BULK_OP_ID);
    showAlert_("✅ ดึงข้อมูลสินค้าและเขียนลงชีตเรียบร้อยแล้ว!");
    return;
  }
  
  if (opId) {
    Logger.log("Found existing bulk operation ID: " + opId);
  } else if (currentOp && (currentOp.status === "RUNNING" || currentOp.status === "CREATED")) {
    opId = currentOp.id;
    props.setProperty(PROP_LAST_BULK_OP_ID, opId);
    Logger.log("Adopted active bulk operation: " + opId);
  } else {
    // เริ่มการสร้าง Bulk Query ใหม่
    Logger.log("Starting a new bulk query...");
    opId = startBulkQuery_();
    if (!opId) {
      showAlert_("❌ ไม่สามารถเริ่มการดึงข้อมูลได้ โปรดตรวจสอบ Log");
      return;
    }
    props.setProperty(PROP_LAST_BULK_OP_ID, opId);
    Logger.log("New bulk operation started: " + opId);
  }
  
  // 2. ตรวจสอบสถานะและรอประมวลผล
  const result = pollStatus_(opId);
  
  if (result.status === "COMPLETED") {
    downloadAndProcessJSONL_(result.url);
    props.deleteProperty(PROP_LAST_BULK_OP_ID); // ลบออกเมื่อทำงานเสร็จสมบูรณ์แล้วเท่านั้น
    showAlert_("✅ ดึงข้อมูลสินค้าและเขียนลงชีตเรียบร้อยแล้ว!");
  } else if (result.status === "RUNNING" || result.status === "CREATED") {
    showAlert_("⏳ ข้อมูลกำลังจัดเตรียมอยู่บน Shopify...");
  } else {
    props.deleteProperty(PROP_LAST_BULK_OP_ID);
    showAlert_("❌ การประมวลผลบน Shopify ล้มเหลว (สถานะ: " + result.status + ")");
  }
}

// ============================================================
// 1. START BULK QUERY
// ============================================================
function startBulkQuery_() {
  const INNER_QUERY = `
{
  products {
    edges {
      node {
        id
        handle
        title
        vendor
        productType
        tags
        status
        publishedAt
        variants {
          edges {
            node {
              id
              sku
              price
              compareAtPrice
              inventoryQuantity
              inventoryItem { id }
            }
          }
        }
        images(first: 1) {
          edges {
            node {
              id
              url
            }
          }
        }
        metafields {
          edges {
            node {
              namespace
              key
              value
            }
          }
        }
      }
    }
  }
}
  `;

  const BULK_MUTATION = `
mutation BulkQuery($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status }
    userErrors { field message }
  }
}
  `;

  const payload = {
    query: BULK_MUTATION,
    variables: { query: INNER_QUERY }
  };

  const res = callGraphQL_(payload);
  if (!res || !res.data || !res.data.bulkOperationRunQuery) {
    Logger.log("[ERROR] Failed to start query: " + JSON.stringify(res));
    return null;
  }
  
  const opData = res.data.bulkOperationRunQuery;
  if (opData.userErrors && opData.userErrors.length > 0) {
    Logger.log("[ERROR] " + JSON.stringify(opData.userErrors));
    return null;
  }
  
  return opData.bulkOperation.id;
}

// ============================================================
// 2. POLL STATUS
// ============================================================
function pollStatus_(bulkOperationId) {
  const POLL_QUERY = `
    query GetBulkOperation($id: ID!) {
      node(id: $id) {
        ... on BulkOperation {
          id
          status
          errorCode
          objectCount
          url
        }
      }
    }
  `;
  const payload = {
    query: POLL_QUERY,
    variables: { id: bulkOperationId }
  };
  
  const startTime = Date.now();
  const maxPollTimeMs = 300000; // รอเช็คสถานะสูงสุด 5 นาทีจนกว่า Shopify จะจัดเตรียมข้อมูลเสร็จ
  
  while (true) {
    const res = callGraphQL_(payload);
    const op = (res && res.data && res.data.node) ? res.data.node : null;
    
    if (!op) {
      Logger.log("[ERROR] Bulk operation not found for ID: " + bulkOperationId);
      return { status: "NOT_FOUND" };
    }
    
    Logger.log(`  [${op.status}] ${op.objectCount} objects`);
    
    if (op.status === "COMPLETED") {
      return { status: "COMPLETED", url: op.url };
    }
    
    if (op.status === "FAILED" || op.status === "CANCELED") {
      Logger.log("[ERROR] Bulk operation failed: " + op.errorCode);
      return { status: op.status, errorCode: op.errorCode };
    }
    
    if (Date.now() - startTime > maxPollTimeMs) {
      Logger.log("Polling paused. Still processing: " + op.status);
      return { status: op.status, objectCount: op.objectCount };
    }
    
    Utilities.sleep(POLL_INTERVAL_MS);
  }
}

// ============================================================
// 3. DOWNLOAD & PROCESS JSONL (แบบทยอยโหลดทีละ 5MB แก้บัคตัดจบ)
// ============================================================
function downloadAndProcessJSONL_(url) {
  Logger.log("Downloading result in chunks to prevent timeout/truncation...");
  
  const products = {};
  const variants = {};
  const meta = {};
  const productImages = {};
  
  let startByte = 0;
  const CHUNK_SIZE = 5 * 1024 * 1024; // โหลดทีละ 5MB ป้องกัน Apps Script ค้าง
  let totalLinesParsed = 0;
  
  while (true) {
    const endByte = startByte + CHUNK_SIZE - 1;
    Logger.log(`  Fetching bytes ${startByte}-${endByte}...`);
    
    const res = UrlFetchApp.fetch(url, {
      headers: { "Range": `bytes=${startByte}-${endByte}` },
      muteHttpExceptions: true
    });
    
    const code = res.getResponseCode();
    if (code >= 400) {
       if (code === 416) break; // HTTP 416 Range Not Satisfiable = จบไฟล์แล้ว
       Logger.log("[ERROR] Download chunk failed (HTTP " + code + "): " + res.getContentText());
       return;
    }
    
    const bytes = res.getContent();
    if (!bytes || bytes.length === 0) break;
    
    let isDone = false;
    let validBytes = bytes;
    let nextStart = startByte + bytes.length;
    
    // ถ้าเซิร์ฟเวอร์คืนค่ามาเป็น Partial Content (206) และเราได้มาเต็ม Chunk ขนาด 5MB
    if (code === 206 && bytes.length === CHUNK_SIZE) {
      // หาตำแหน่ง \n (Byte 10) ตัวสุดท้าย เพื่อตัดบรรทัดไม่ให้ JSON ขาดครึ่ง
      const lastNewlineIndex = bytes.lastIndexOf(10);
      if (lastNewlineIndex !== -1) {
        validBytes = bytes.slice(0, lastNewlineIndex + 1);
        nextStart = startByte + lastNewlineIndex + 1; // ยกยอด Byte ที่เหลือไปโหลดในรอบถัดไป
      }
    } else {
      // ถ้าเป็น 200 (เซิร์ฟเวอร์ส่งไฟล์เต็มมาเลย) หรือเป็น Chunk สุดท้าย
      isDone = true;
    }
    
    // แปลง Byte Array เป็นข้อความ
    const chunkText = Utilities.newBlob(validBytes).getDataAsString();
    const lines = chunkText.split('\n');
    
    // Parse JSON แต่ละบรรทัดใน Chunk นี้
    lines.forEach(line => {
      if (!line.trim()) return;
      totalLinesParsed++;
      try {
        const obj = JSON.parse(line);
        const gid = obj.id || "";
        const parent = obj.__parentId || "";
        
        if (gid.indexOf("/Product/") !== -1 && !parent) {
          products[gid] = obj;
        } else if (gid.indexOf("/ProductVariant/") !== -1 && parent) {
          if (!variants[parent]) variants[parent] = [];
          variants[parent].push(obj);
        } else if ((gid.indexOf("/ProductImage/") !== -1 || gid.indexOf("/Image/") !== -1) && parent) {
          if (!productImages[parent]) productImages[parent] = [];
          productImages[parent].push(obj.url);
        } else if (obj.namespace && obj.key && parent) {
          if (!meta[parent]) meta[parent] = {};
          meta[parent][`${obj.namespace}.${obj.key}`] = obj.value;
        }
      } catch (e) {
        // Ignore parse error
      }
    });
    
    if (isDone) break;
    startByte = nextStart;
  }
  
  Logger.log(`  ${totalLinesParsed} lines downloaded and parsed.`);
  
  // ---------------------------------------------------------
  // จัดเตรียมข้อมูลลง Google Sheet (เฉพาะ 17 Columns ที่กำหนด)
  // ---------------------------------------------------------
  const finalHeaders = [
    "custom.good_id",
    "Variant SKU",
    "Product GID",
    "Variant GID",
    "Inventory Item ID",
    "Handle",
    "Title",
    "Vendor",
    "Type",
    "Tags",
    "Status",
    "Published",
    "Price",
    "Compare At Price",
    "Inventory",
    "Image Src",
    "custom.spapart_or_product"
  ];
  
  const allRowsData = [];
  
  Object.keys(products).forEach(pid => {
    const p = products[pid];
    const mf = meta[pid] || {};
    const pVariants = variants[pid] || [{}];
    
    pVariants.forEach(v => {
      const vid = v.id || "";
      const inv = (v.inventoryItem && v.inventoryItem.id) ? v.inventoryItem.id : "";
      const vmf = meta[vid] || {};
      const pImgs = productImages[pid] || [];
      
      const rowObj = {
        "Variant SKU": v.sku || "",
        "Product GID": pid,
        "Variant GID": vid,
        "Inventory Item ID": inv,
        "Handle": p.handle || "",
        "Title": p.title || "",
        "Vendor": p.vendor || "",
        "Type": p.productType || "",
        "Tags": (p.tags || []).join(", "),
        "Status": p.status || "",
        "Published": p.publishedAt ? "TRUE" : "FALSE",
        "Price": v.price != null ? v.price : "",
        "Compare At Price": v.compareAtPrice != null ? v.compareAtPrice : "",
        "Inventory": v.inventoryQuantity != null ? v.inventoryQuantity : "",
        "Image Src": pImgs.length > 0 ? pImgs[0] : ""
      };
      
      // ดึง Metafields ที่สัมพันธ์กันเข้ามา
      Object.assign(rowObj, mf);
      Object.assign(rowObj, vmf);
      
      // จัดรูปแบบ custom.good_id
      let goodId = rowObj["custom.good_id"];
      if (goodId != null && goodId !== "") {
        let parsed = parseInt(goodId, 10);
        rowObj["custom.good_id"] = isNaN(parsed) ? "" : parsed;
      } else {
        rowObj["custom.good_id"] = "";
      }
      
      // จัดรูปแบบ custom.spapart_or_product
      if (rowObj["custom.spapart_or_product"] == null) {
        rowObj["custom.spapart_or_product"] = "";
      }
      
      allRowsData.push(rowObj);
    });
  });
  
  const finalRows2D = [finalHeaders];
  allRowsData.forEach(rowObj => {
    finalRows2D.push(finalHeaders.map(h => {
      return rowObj[h] != null ? rowObj[h] : "";
    }));
  });
  
  Logger.log(`  ${allRowsData.length} variant rows assembled.`);
  
  // ---------------------------------------------------------
  // เขียนลง Sheet (ใช้ Lock ป้องกันสคริปต์ชนกัน)
  // ---------------------------------------------------------
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(60000); // รอได้สูงสุด 60 วินาที
  } catch (e) {
    Logger.log("❌ Could not acquire lock: " + e.toString());
    throw new Error("Spreadsheet is currently locked by another run. Please try again later.");
  }
  
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(EXPORT_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(EXPORT_SHEET_NAME);
    } else {
      const lastR = sheet.getLastRow();
      const lastC = sheet.getLastColumn();
      if (lastR > 0 && lastC > 0) {
        sheet.getRange(1, 1, lastR, lastC).clearContent();
      }
    }
    
    const targetRows = finalRows2D.length;
    const targetCols = finalHeaders.length;
    
    const currentRows = sheet.getMaxRows();
    const currentCols = sheet.getMaxColumns();
    
    if (currentCols < targetCols) {
      sheet.insertColumnsAfter(currentCols, targetCols - currentCols);
    }
    
    if (currentRows < targetRows) {
      sheet.insertRowsAfter(currentRows, targetRows - currentRows);
    }
    
    sheet.setRowHeight(1, 25);
    
    // Write everything in a single fast call
    sheet.getRange(1, 1, targetRows, targetCols).setValues(finalRows2D);
    
    // 3. จัดรูปแบบหัวตาราง
    sheet.getRange(1, 1, 1, targetCols).setFontWeight("bold");
    sheet.getRange(1, 1, 1, targetCols).setWrap(false);
    sheet.setFrozenRows(1);
    
    Logger.log(`✅ ${allRowsData.length} products exported to sheet '${EXPORT_SHEET_NAME}'`);
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// 4. CLEAN HTML IN SHEET (แยกรันทีหลัง จะได้ไม่ Timeout)
// ============================================================
function cleanHtmlInSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(EXPORT_SHEET_NAME);
  if (!sheet) {
    showAlert_("ไม่พบ Sheet: " + EXPORT_SHEET_NAME);
    return;
  }
  
  // หาว่าคอลัมน์ "Body (HTML)" อยู่ตำแหน่งไหน
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIndex = headers.indexOf("Body (HTML)");
  
  if (colIndex === -1) {
    showAlert_("ไม่พบคอลัมน์ 'Body (HTML)'");
    return;
  }
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  
  // 1. โหลดข้อมูลมาแค่คอลัมน์เดียว (ทำงานไวมาก)
  const range = sheet.getRange(2, colIndex + 1, lastRow - 1, 1);
  const values = range.getValues();
  
  // 2. แปลง HTML ทุกบรรทัด
  for (let i = 0; i < values.length; i++) {
    if (values[i][0]) {
      values[i][0] = stripHtml_(values[i][0]);
    }
  }
  
  // 3. เขียนข้อมูลที่แปลงแล้วกลับลงไป
  range.setValues(values);
  showAlert_("แปลง HTML เป็นข้อความปกติเรียบร้อยแล้ว!");
}

// ============================================================
// HELPER: AUTH (Auto Refresh Token)
// ============================================================
function getAccessToken_() {
  const props  = PropertiesService.getScriptProperties();
  const token  = props.getProperty(PROP_ACCESS_TOKEN);
  const expiry = Number(props.getProperty(PROP_TOKEN_EXPIRY) || 0);

  if (token && Date.now() < expiry - 300000) return token;

  Logger.log("Token expired or not found. Requesting new token...");
  const res  = UrlFetchApp.fetch("https://" + SHOP + "/admin/oauth/access_token", {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: "grant_type=client_credentials&client_id=" + encodeURIComponent(CLIENT_ID) + "&client_secret=" + encodeURIComponent(CLIENT_SECRET),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  let data;
  try { 
    data = JSON.parse(text); 
  } catch (e) {
    throw new Error("Token response is not valid JSON. HTTP " + code + ": " + text);
  }
  if (!data.access_token) throw new Error("Token failed. HTTP " + code + ": " + text);

  const newExpiry = Date.now() + ((Number(data.expires_in) || 3600) * 1000);
  props.setProperty(PROP_ACCESS_TOKEN, data.access_token);
  props.setProperty(PROP_TOKEN_EXPIRY, String(newExpiry));
  
  Logger.log("New token acquired successfully.");
  return data.access_token;
}

// ============================================================
// HELPER: GRAPHQL CALLER
// ============================================================
function callGraphQL_(payload) {
  const accessToken = getAccessToken_();

  const options = {
    method: "post",
    contentType: "application/json",
    headers: { "X-Shopify-Access-Token": accessToken },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  const res = UrlFetchApp.fetch("https://" + SHOP + "/admin/api/2025-01/graphql.json", options);
  
  if (res.getResponseCode() >= 400) {
    Logger.log("[ERROR] GraphQL HTTP " + res.getResponseCode() + ": " + res.getContentText().substring(0, 300));
    return null;
  }
  
  return JSON.parse(res.getContentText());
}

// ============================================================
// HELPER: แปลง HTML เป็น Plain Text
// ============================================================
function stripHtml_(html) {
  if (!html) return "";
  
  // แปลง tag ขึ้นบรรทัดใหม่เพื่อให้อ่านง่าย
  let text = String(html);
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<li>/gi, '- ');
  
  // ลบ HTML tags ที่เหลือออกทั้งหมด
  text = text.replace(/<[^>]+>/g, '');
  
  // แปลงรหัสอักขระ (HTML Entities) กลับเป็นข้อความปกติ
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  
  // ลบช่องว่างหรือบรรทัดที่ว่างเกินไป
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
  
  return text.trim();
}

// ============================================================
// HELPER: แสดง Alert อย่างปลอดภัย แม้ไม่ได้รันจากหน้าต่างชีตโดยตรง (เช่น รันผ่าน Editor)
// ============================================================
function showAlert_(message) {
  Logger.log("ALERT: " + message);
}

// ============================================================
// WEBHOOK ENDPOINT FOR PYTHON (ไม่ต้องใช้ Google Cloud / บัตรเครดิต)
// ============================================================
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(60000); // รอได้สูงสุด 60 วินาที
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Spreadsheet is locked: " + err.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
  
  try {
    const contents = JSON.parse(e.postData.contents);
    const rows = contents.rows;
    if (!rows || !rows.length) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "No rows provided" })).setMimeType(ContentService.MimeType.JSON);
    }
    
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(EXPORT_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(EXPORT_SHEET_NAME);
    }
    
    // Clear content of existing data range quickly
    const lastR = sheet.getLastRow();
    const lastC = sheet.getLastColumn();
    if (lastR > 0 && lastC > 0) {
      sheet.getRange(1, 1, lastR, lastC).clearContent();
    }
    
    const targetRows = rows.length;
    const targetCols = rows[0].length;
    
    const currentRows = sheet.getMaxRows();
    const currentCols = sheet.getMaxColumns();
    
    if (currentCols < targetCols) {
      sheet.insertColumnsAfter(currentCols, targetCols - currentCols);
    }
    
    if (currentRows < targetRows) {
      sheet.insertRowsAfter(currentRows, targetRows - currentRows);
    }
    
    sheet.setRowHeight(1, 25);
    
    // Write everything in a single fast call
    sheet.getRange(1, 1, targetRows, targetCols).setValues(rows);
    
    sheet.getRange(1, 1, 1, targetCols).setFontWeight("bold");
    sheet.getRange(1, 1, 1, targetCols).setWrap(false);
    sheet.setFrozenRows(1);
    
    return ContentService.createTextOutput(JSON.stringify({ status: "success", count: targetRows - 1 })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
