// ============================================================
// CONFIG
// ============================================================
var SHOP = PropertiesService.getScriptProperties().getProperty("SHOP") || "sevenfive-4062.myshopify.com";
var CLIENT_ID = PropertiesService.getScriptProperties().getProperty("CLIENT_ID") || "696e1e9162c702cc07c2f94a1beacf8a";
var CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("CLIENT_SECRET") || "YOUR_CLIENT_SECRET";
// ============================================================
var EXPORT_SHEET_NAME = "web sevenfive data";
var POLL_INTERVAL_MS = 10000; // เช็คสถานะทุกๆ 10 วินาที

// Keys สำหรับเก็บ Token ลง Properties
var PROP_ACCESS_TOKEN = "ACCESS_TOKEN";
var PROP_TOKEN_EXPIRY = "TOKEN_EXPIRY";
var PROP_LAST_BULK_OP_ID = "LAST_BULK_OP_ID_PRODUCT_DATA";

// ============================================================
// UI MENU
// ============================================================
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('📦 Shopify Tools')
    .addItem('Export Product Data (สินค้า)', 'exportProductDataProduct')
    .addToUi();
}

// ============================================================
// MAIN FUNCTION
// ============================================================
function exportProductDataProduct() {
  const props = PropertiesService.getScriptProperties();
  const savedOpId = props.getProperty(PROP_LAST_BULK_OP_ID);
  
  Logger.log("Checking Shopify bulk operation status...");
  const checkRes = callGraphQL_({ query: `{ currentBulkOperation(type: QUERY) { id status url objectCount } }` });
  const currentOp = (checkRes && checkRes.data) ? checkRes.data.currentBulkOperation : null;
  
  // === Case 1: Shopify ทำไฟล์เสร็จเรียบร้อย (COMPLETED) → ดาวน์โหลดและเขียนลง Sheet ทันที ===
  if (currentOp && currentOp.status === "COMPLETED" && currentOp.url) {
    if (savedOpId === currentOp.id || savedOpId) {
      Logger.log("✅ Bulk op COMPLETED (" + currentOp.objectCount + " objects) — downloading now...");
      props.deleteProperty(PROP_LAST_BULK_OP_ID);
      downloadAndProcessJSONL_(currentOp.url);
      showAlert_("✅ Export Product Data (สินค้า) สำเร็จ! " + currentOp.objectCount + " รายการ");
      return;
    }
  }
  
  // === Case 2: Shopify กำลังประมวลผลอยู่ (RUNNING / CREATED) → บันทึก ID ไว้แล้วรอ Trigger รอบถัดไป ===
  if (currentOp && (currentOp.status === "RUNNING" || currentOp.status === "CREATED")) {
    props.setProperty(PROP_LAST_BULK_OP_ID, currentOp.id);
    Logger.log("⏳ Shopify กำลังประมวลผลอยู่ (" + currentOp.status + ", " + (currentOp.objectCount || 0) + " objects) — จะดาวน์โหลดเมื่อ Trigger รอบถัดไปทำงาน");
    showAlert_("⏳ Shopify กำลังประมวลผลอยู่ รอ Trigger รอบถัดไปดึงข้อมูลอัตโนมัติ");
    return;
  }
  
  // === Case 3: ยังไม่มี op ใหม่ → สั่งเริ่ม Bulk Query แล้วจบฟังก์ชันทันที ===
  if (currentOp && currentOp.status === "COMPLETED") {
    Logger.log("Old COMPLETED op (" + currentOp.objectCount + " objects) — starting FRESH query for product data...");
  } else {
    Logger.log("Starting a new bulk query for products (custom.spapart_or_product: สินค้า)...");
  }
  
  const opId = startBulkQuery_();
  if (!opId) {
    showAlert_("❌ ไม่สามารถเริ่ม query ได้ โปรดตรวจสอบ Log");
    return;
  }
  
  props.setProperty(PROP_LAST_BULK_OP_ID, opId);
  Logger.log("🚀 New bulk operation started: " + opId + " — เริ่มดึงข้อมูลแล้ว จะดาวน์โหลดเมื่อ Trigger รอบถัดไปทำงาน");
  showAlert_("🚀 เริ่มสั่ง Shopify ดึงข้อมูลเรียบร้อยแล้ว! Trigger รอบถัดไปจะทำการดาวน์โหลดลง Sheet อัตโนมัติ");
}

// ============================================================
// 1. START BULK QUERY
// Filter เฉพาะ metafields.custom.spapart_or_product:สินค้า
// ============================================================
function startBulkQuery_() {
  const INNER_QUERY = `
{
  products(query: "metafields.custom.spapart_or_product:สินค้า") {
    edges {
      node {
        id
        status
        descriptionHtml
        variants {
          edges {
            node {
              id
              sku
            }
          }
        }
        metafields {
          edges {
            node {
              id
              namespace
              key
              value
            }
          }
        }
        media {
          edges {
            node {
              id
              mediaContentType
              ... on ExternalVideo {
                originUrl
                embedUrl
              }
              ... on Video {
                sources {
                  url
                }
              }
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

  const resData = callGraphQL_({
    query: BULK_MUTATION,
    variables: { query: INNER_QUERY }
  });

  if (!resData || !resData.data) {
    Logger.log("[ERROR] startBulkQuery_ response invalid: " + JSON.stringify(resData));
    return null;
  }

  const runResult = resData.data.bulkOperationRunQuery;
  if (runResult.userErrors && runResult.userErrors.length > 0) {
    Logger.log("[ERROR] userErrors: " + JSON.stringify(runResult.userErrors));
    return null;
  }

  return runResult.bulkOperation ? runResult.bulkOperation.id : null;
}

// ============================================================
// 2. POLL STATUS
// ============================================================
function pollStatus_(opId) {
  const query = `{ node(id: "${opId}") { ... on BulkOperation { id status url errorCode createdAt completedAt objectCount fileSize } } }`;
  const resData = callGraphQL_({ query: query });
  
  if (resData && resData.data && resData.data.node) {
    return resData.data.node;
  }
  return { status: "UNKNOWN" };
}

// ============================================================
// 3. DOWNLOAD & PROCESS JSONL
// ============================================================
function downloadAndProcessJSONL_(url) {
  Logger.log("Downloading result in chunks to prevent timeout/truncation...");
  
  const products = {};
  const variants = {};
  const meta = {};
  const productVideos = {};
  
  let startByte = 0;
  const CHUNK_SIZE = 5 * 1024 * 1024; // โหลดทีละ 5MB
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
    
    if (code === 200) {
      isDone = true;
    } else if (code === 206) {
      const contentRange = res.getHeaders()["Content-Range"] || res.getHeaders()["content-range"] || "";
      let totalFileSize = -1;
      const crMatch = contentRange.match(/bytes\s+\d+-\d+\/(\d+)/);
      if (crMatch) totalFileSize = parseInt(crMatch[1], 10);
      
      const receivedEndByte = startByte + bytes.length - 1;
      
      if (totalFileSize > 0 && receivedEndByte >= totalFileSize - 1) {
        isDone = true;
      } else if (bytes.length < CHUNK_SIZE) {
        isDone = true;
      } else {
        const lastNewlineIndex = bytes.lastIndexOf(10);
        if (lastNewlineIndex !== -1) {
          validBytes = bytes.slice(0, lastNewlineIndex + 1);
          nextStart = startByte + lastNewlineIndex + 1;
        }
      }
    }
    
    const chunkText = Utilities.newBlob(validBytes).getDataAsString();
    const lines = chunkText.split('\n');
    
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
        } else if (parent && (obj.mediaContentType || gid.indexOf("/ExternalVideo/") !== -1 || gid.indexOf("/Video/") !== -1)) {
          let videoUrl = "";
          if (obj.originUrl) {
            videoUrl = obj.originUrl;
          } else if (obj.embedUrl) {
            videoUrl = obj.embedUrl;
          } else if (obj.sources && obj.sources.length > 0 && obj.sources[0].url) {
            videoUrl = obj.sources[0].url;
          }
          if (videoUrl) {
            if (!productVideos[parent]) productVideos[parent] = [];
            if (productVideos[parent].indexOf(videoUrl) === -1) {
              productVideos[parent].push(videoUrl);
            }
          }
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
  // จัดเตรียมข้อมูลลง Google Sheet ตาม Columns ที่กำหนด:
  // custom.good_id, Variant SKU, Body (HTML), Status, media video, User Manual, Datasheet, LInk pdf
  // ---------------------------------------------------------
  const finalHeaders = [
    "custom.good_id",
    "Variant SKU",
    "Body (HTML)",
    "Status",
    "media video",
    "User Manual",
    "Datasheet",
    "LInk pdf"
  ];
  
  const allRowsData = [];
  
  Object.keys(products).forEach(pid => {
    const p = products[pid];
    const mf = meta[pid] || {};
    
    // Double check filter: custom.spapart_or_product = "สินค้า"
    const spVal = mf["custom.spapart_or_product"];
    if (spVal && spVal !== "สินค้า") {
      return;
    }
    
    const pVariants = variants[pid] || [{}];
    const pVideos = productVideos[pid] || [];
    const videoStr = pVideos.join(", ");
    
    // ดึง custom.good_id
    let goodId = mf["custom.good_id"];
    if (goodId != null && goodId !== "") {
      let parsed = parseInt(goodId, 10);
      goodId = isNaN(parsed) ? "" : parsed;
    } else {
      goodId = "";
    }
    
    // ดึง User Manual, Datasheet และ Link PDF
    const userManual = mf["custom.user_manual"] || mf["custom.manual"] || mf["custom.user_manual_url"] || "";
    const datasheet = mf["custom.datasheet"] || mf["custom.datasheet_url"] || "";
    const linkPdf = mf["custom.link_pdf"] || mf["custom.pdf_link"] || mf["custom.link_pdf_url"] || "";
    const bodyHtml = p.descriptionHtml || "";
    const status = p.status || "";
    
    pVariants.forEach(v => {
      const sku = v.sku || "";
      const rowObj = {
        "custom.good_id": goodId,
        "Variant SKU": sku,
        "Body (HTML)": bodyHtml,
        "Status": status,
        "media video": videoStr,
        "User Manual": userManual,
        "Datasheet": datasheet,
        "LInk pdf": linkPdf
      };
      
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
  // เขียนลง Sheet (ใช้ Sheets API service)
  // ---------------------------------------------------------
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ssId = ss.getId();
  let sheet = ss.getSheetByName(EXPORT_SHEET_NAME);
  
  if (!sheet) {
    sheet = ss.insertSheet(EXPORT_SHEET_NAME);
    SpreadsheetApp.flush();
  }
  
  const targetRows = finalRows2D.length;
  const targetCols = finalHeaders.length;
  let usedSheetsApi = false;
  
  if (typeof Sheets !== "undefined") {
    try {
      Logger.log("  Writing with Sheets API...");
      const sheetId = sheet.getSheetId();
      
      Sheets.Spreadsheets.Values.clear({}, ssId, EXPORT_SHEET_NAME);
      
      const currentMaxRows = sheet.getMaxRows();
      const requests = [
        {
          updateSheetProperties: {
            properties: { sheetId: sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount"
          }
        }
      ];
      
      if (currentMaxRows < targetRows) {
        requests.push({
          appendDimension: {
            sheetId: sheetId,
            dimension: "ROWS",
            length: targetRows - currentMaxRows
          }
        });
      }
      
      Sheets.Spreadsheets.batchUpdate({ requests: requests }, ssId);
      
      const lastColLetter = String.fromCharCode(64 + targetCols);
      const BATCH_SIZE_ROWS = 8000;
      for (let i = 0; i < finalRows2D.length; i += BATCH_SIZE_ROWS) {
        const chunk2D = finalRows2D.slice(i, i + BATCH_SIZE_ROWS);
        const startRow = i + 1;
        const endRow = i + chunk2D.length;
        const rangeStr = `${EXPORT_SHEET_NAME}!A${startRow}:${lastColLetter}${endRow}`;
        
        Sheets.Spreadsheets.Values.update(
          { values: chunk2D },
          ssId,
          rangeStr,
          { valueInputOption: "RAW" }
        );
      }
      
      usedSheetsApi = true;
      Logger.log(`  ✅ Done writing ${targetRows} rows with Sheets API.`);
    } catch (apiErr) {
      Logger.log("  [WARN] Sheets API failed (" + apiErr.message + "), falling back to setValues...");
    }
  }
  
  if (!usedSheetsApi) {
    sheet.clear();
    const currentMaxRows = sheet.getMaxRows();
    if (currentMaxRows < targetRows) {
      sheet.insertRowsAfter(currentMaxRows, targetRows - currentMaxRows);
    }
    
    const BATCH_SIZE_ROWS = 2000;
    for (let i = 0; i < finalRows2D.length; i += BATCH_SIZE_ROWS) {
      const chunk2D = finalRows2D.slice(i, i + BATCH_SIZE_ROWS);
      const range = sheet.getRange(i + 1, 1, chunk2D.length, targetCols);
      range.setValues(chunk2D);
    }
    sheet.setFrozenRows(1);
    Logger.log(`  ✅ Done writing ${targetRows} rows with setValues.`);
  }
  
  // บันทึก Log ลงชีท "Logrun script"
  logToSheet_(allRowsData.length, usedSheetsApi);
}

// ============================================================
// HELPER: GET ACCESS TOKEN
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
// HELPER: SHOW ALERT
// ============================================================
function showAlert_(message) {
  Logger.log("ALERT: " + message);
}

// ============================================================
// HELPER: LOG TO SHEET "Logrun script"
// ============================================================
var LOG_SHEET_NAME = "Logrun script";

function logToSheet_(rowCount, usedSheetsApi) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let logSheet = ss.getSheetByName(LOG_SHEET_NAME);
    
    if (!logSheet) {
      logSheet = ss.insertSheet(LOG_SHEET_NAME);
      logSheet.getRange(1, 1, 1, 4).setValues([["Timestamp", "Status", "Rows Exported", "Write Method"]]);
      logSheet.getRange(1, 1, 1, 4).setFontWeight("bold");
      logSheet.setFrozenRows(1);
    }
    
    const now = new Date();
    const timestamp = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
    const method = usedSheetsApi ? "Sheets API" : "setValues";
    
    logSheet.appendRow([timestamp, "✅ Product Data Success", rowCount, method]);
    Logger.log("[LOG] บันทึก Log ลงชีทเรียบร้อย: " + timestamp + " | " + rowCount + " rows");
  } catch (logErr) {
    Logger.log("[WARN] ไม่สามารถบันทึก Log ลงชีทได้: " + logErr.message);
  }
}
