// ============================================================
// CONFIG
// ============================================================
const SHOP = "sevenfive-4062.myshopify.com";
const CLIENT_ID = "xxxxxxxxxxxxxxxxxxx";
const CLIENT_SECRET = "xxxxxxxxxxxxxxxxxxx";

const EXPORT_SHEET_NAME = "Products Export";
const POLL_INTERVAL_MS = 10000; // เช็คสถานะทุกๆ 10 วินาที

// Keys สำหรับเก็บ Token ลง Properties
const PROP_ACCESS_TOKEN = "ACCESS_TOKEN";
const PROP_TOKEN_EXPIRY = "TOKEN_EXPIRY";

// ============================================================
// UI MENU
// ============================================================
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('📦 Shopify Tools')
    .addItem('1. Export Products to Sheet', 'exportProductsToSheet')
    .addItem('2. Clean HTML in Sheet', 'cleanHtmlInSheet')
    .addToUi();
}

// ============================================================
// MAIN FUNCTION
// ============================================================
function exportProductsToSheet() {
  Logger.log("Starting bulk product query...");
  
  const opId = startBulkQuery_();
  if (!opId) return;
  
  Logger.log("Bulk operation started: " + opId);
  Logger.log("Polling...");
  
  const resultUrl = pollStatus_();
  if (!resultUrl) return;
  
  downloadAndProcessJSONL_(resultUrl);
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
        description
        descriptionHtml
        vendor
        productType
        tags
        status
        publishedAt
        seo { title description }
        category { name fullName }
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
        featuredImage { url }
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
function pollStatus_() {
  const POLL_QUERY = `{ currentBulkOperation(type: QUERY) { id status errorCode objectCount url } }`;
  const payload = { query: POLL_QUERY };
  const startTime = Date.now();
  
  while (true) {
    if (Date.now() - startTime > 5 * 60 * 1000) {
      Logger.log("[ERROR] Polling timed out (5 mins). Please try again later.");
      return null;
    }
    
    const res = callGraphQL_(payload);
    const op = (res && res.data) ? res.data.currentBulkOperation : null;
    
    if (!op) {
      Logger.log("[ERROR] No active bulk operation.");
      return null;
    }
    
    Logger.log(`  [${op.status}] ${op.objectCount} objects`);
    
    if (op.status === "COMPLETED") {
      return op.url;
    }
    
    if (op.status === "FAILED" || op.status === "CANCELED") {
      Logger.log("[ERROR] Bulk operation failed: " + op.errorCode);
      return null;
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
  // จัดเตรียมข้อมูลลง Google Sheet
  // ---------------------------------------------------------
  const baseHeaders = [
    "Variant SKU", "Product GID", "Variant GID", 
    "Inventory Item ID", "Handle", "Title", "Body (HTML)", "Vendor", 
    "Type", "Tags", "Status", "Published", "Price", "Compare At Price", 
    "Inventory", "Image Src", "SEO Title", "SEO Description", "Category"
  ];
  
  const allRowsData = [];
  const metaKeysSet = new Set();
  
  Object.keys(products).forEach(pid => {
    const p = products[pid];
    const mf = meta[pid] || {};
    const pVariants = variants[pid] || [{}];
    
    Object.keys(mf).forEach(k => metaKeysSet.add(k));
    
    pVariants.forEach(v => {
      const vid = v.id || "";
      const inv = (v.inventoryItem && v.inventoryItem.id) ? v.inventoryItem.id : "";
      const vmf = meta[vid] || {};
      
      Object.keys(vmf).forEach(k => metaKeysSet.add(k));
      
      const rowObj = {
        "Variant SKU": v.sku || "",
        "Product GID": pid,
        "Variant GID": vid,
        "Inventory Item ID": inv,
        "Handle": p.handle || "",
        "Title": p.title || "",
        "Body (HTML)": p.descriptionHtml || "", // ดึง HTML มาก่อน จะได้ไม่ Timeout
        "Vendor": p.vendor || "",
        "Type": p.productType || "",
        "Tags": (p.tags || []).join(", "),
        "Status": p.status || "",
        "Published": p.publishedAt ? "TRUE" : "FALSE",
        "Price": v.price != null ? v.price : "",
        "Compare At Price": v.compareAtPrice != null ? v.compareAtPrice : "",
        "Inventory": v.inventoryQuantity != null ? v.inventoryQuantity : "",
        "Image Src": (p.featuredImage && p.featuredImage.url) ? p.featuredImage.url : "",
        "SEO Title": (p.seo && p.seo.title) ? p.seo.title : "",
        "SEO Description": (p.seo && p.seo.description) ? p.seo.description : "",
        "Category": (p.category && p.category.fullName) ? p.category.fullName : ""
      };
      
      let goodId = mf["custom.good_id"];
      if (goodId != null) {
        let parsed = parseInt(goodId, 10);
        rowObj["custom.good_id"] = isNaN(parsed) ? "" : parsed;
      } else {
        rowObj["custom.good_id"] = "";
      }
      
      Object.assign(rowObj, mf);
      Object.assign(rowObj, vmf); 
      
      allRowsData.push(rowObj);
    });
  });
  
  const metaHeaders = Array.from(metaKeysSet).sort();
  let finalHeaders = [...baseHeaders];
  
  if (metaHeaders.includes("custom.good_id")) {
    finalHeaders.unshift("custom.good_id");
    metaHeaders.splice(metaHeaders.indexOf("custom.good_id"), 1);
  } else {
    finalHeaders.unshift("custom.good_id");
  }
  
  finalHeaders = finalHeaders.concat(metaHeaders);
  
  const finalRows2D = [finalHeaders];
  allRowsData.forEach(rowObj => {
    finalRows2D.push(finalHeaders.map(h => rowObj[h] != null ? rowObj[h] : ""));
  });
  
  Logger.log(`  ${allRowsData.length} variant rows assembled.`);
  
  // ---------------------------------------------------------
  // เขียนลง Sheet (แบ่งเขียนทีละ Chunk กันค้าง)
  // ---------------------------------------------------------
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(EXPORT_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(EXPORT_SHEET_NAME);
  } else {
    sheet.clear();
  }
  
  sheet.getRange(1, 1, 1, finalHeaders.length).setFontWeight("bold");
  sheet.setFrozenRows(1);
  
  const CHUNK_SIZE_WRITE = 5000;
  for (let i = 0; i < finalRows2D.length; i += CHUNK_SIZE_WRITE) {
    const chunk = finalRows2D.slice(i, i + CHUNK_SIZE_WRITE);
    sheet.getRange(i + 1, 1, chunk.length, chunk[0].length).setValues(chunk);
    SpreadsheetApp.flush();
  }
  
  Logger.log(`✅ ${allRowsData.length} products exported to sheet '${EXPORT_SHEET_NAME}'`);
}

// ============================================================
// 4. CLEAN HTML IN SHEET (แยกรันทีหลัง จะได้ไม่ Timeout)
// ============================================================
function cleanHtmlInSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(EXPORT_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert("ไม่พบ Sheet: " + EXPORT_SHEET_NAME);
    return;
  }
  
  // หาว่าคอลัมน์ "Body (HTML)" อยู่ตำแหน่งไหน
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIndex = headers.indexOf("Body (HTML)");
  
  if (colIndex === -1) {
    SpreadsheetApp.getUi().alert("ไม่พบคอลัมน์ 'Body (HTML)'");
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
  SpreadsheetApp.getUi().alert("แปลง HTML เป็นข้อความปกติเรียบร้อยแล้ว!");
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
