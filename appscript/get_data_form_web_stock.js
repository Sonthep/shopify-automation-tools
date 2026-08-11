const TARGET_SHEET_NAME = "price website";
const POLL_INTERVAL_MS = 10000; 

// Keys สำหรับเก็บ Token
const PROP_ACCESS_TOKEN = "ACCESS_TOKEN";
const PROP_TOKEN_EXPIRY = "TOKEN_EXPIRY";
const PROP_LAST_BULK_OP_ID_PRICE = "LAST_BULK_OP_ID_PRICE";



// ============================================================
// MAIN FUNCTION
// ============================================================
function syncPriceWebsiteFromShopify() {
  const props = PropertiesService.getScriptProperties();
  let opId = props.getProperty(PROP_LAST_BULK_OP_ID_PRICE);
  
  if (opId) {
    Logger.log("Found existing bulk operation: " + opId);
  } else {
    // เช็คว่ามี Bulk Query อื่นที่กำลังทำงานบน Shopify หรือไม่
    Logger.log("Checking current bulk operation status...");
    const checkQuery = `{ currentBulkOperation(type: QUERY) { id status url } }`;
    const checkRes = callGraphQL_({ query: checkQuery });
    const currentOp = (checkRes && checkRes.data) ? checkRes.data.currentBulkOperation : null;
    
    if (currentOp && (currentOp.status === "RUNNING" || currentOp.status === "CREATED")) {
      opId = currentOp.id;
      props.setProperty(PROP_LAST_BULK_OP_ID_PRICE, opId);
      Logger.log("Adopted active bulk operation: " + opId);
    } else {
      // เริ่มการสร้าง Bulk Query ใหม่
      Logger.log("Starting a new bulk query...");
      opId = startBulkQuery_();
      if (!opId) {
        Logger.log("❌ ไม่สามารถเริ่มการดึงข้อมูลได้");
        return;
      }
      props.setProperty(PROP_LAST_BULK_OP_ID_PRICE, opId);
      Logger.log("New bulk operation started: " + opId);
    }
  }
  
  // ตรวจสอบสถานะและรอชั่วคราว (สูงสุดประมาณ 45 วินาที)
  const result = pollStatus_(opId);
  
  if (result.status === "COMPLETED") {
    props.deleteProperty(PROP_LAST_BULK_OP_ID_PRICE);
    downloadAndProcessJSONL_(result.url);
    Logger.log("✅ ดึงข้อมูลสินค้าและเขียนลงชีต '" + TARGET_SHEET_NAME + "' เรียบร้อยแล้ว!");
  } else if (result.status === "RUNNING" || result.status === "CREATED") {
    Logger.log("⏳ ข้อมูลกำลังจัดเตรียมอยู่บน Shopify...");
  } else {
    // ล้มเหลวหรือถูกยกเลิก (FAILED, CANCELED)
    props.deleteProperty(PROP_LAST_BULK_OP_ID_PRICE);
    Logger.log("❌ การประมวลผลบน Shopify ล้มเหลว (สถานะ: " + result.status + ")");
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
        metafield(namespace: "custom", key: "good_id") {
          value
        }
        variants {
          edges {
            node {
              id
              sku
              price
              compareAtPrice
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
  const maxPollTimeMs = 45000; 
  
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
// 3. DOWNLOAD & PROCESS JSONL
// ============================================================
function downloadAndProcessJSONL_(url) {
  Logger.log("Downloading result in chunks...");
  
  const products = {};
  const variants = {};
  const meta = {};
  
  let startByte = 0;
  const CHUNK_SIZE = 5 * 1024 * 1024; 
  let totalLinesParsed = 0;
  
  while (true) {
    const endByte = startByte + CHUNK_SIZE - 1;
    
    const res = UrlFetchApp.fetch(url, {
      headers: { "Range": `bytes=${startByte}-${endByte}` },
      muteHttpExceptions: true
    });
    
    const code = res.getResponseCode();
    if (code >= 400) {
       if (code === 416) break; 
       Logger.log("[ERROR] Download chunk failed (HTTP " + code + ")");
       return;
    }
    
    const bytes = res.getContent();
    if (!bytes || bytes.length === 0) break;
    
    let isDone = false;
    let validBytes = bytes;
    let nextStart = startByte + bytes.length;
    
    if (code === 206 && bytes.length === CHUNK_SIZE) {
      const lastNewlineIndex = bytes.lastIndexOf(10);
      if (lastNewlineIndex !== -1) {
        validBytes = bytes.slice(0, lastNewlineIndex + 1);
        nextStart = startByte + lastNewlineIndex + 1; 
      }
    } else {
      isDone = true;
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
          if (obj.metafield && obj.metafield.value) {
            obj.custom_good_id = obj.metafield.value;
          }
          products[gid] = obj;
        } else if (gid.indexOf("/ProductVariant/") !== -1 && parent) {
          if (!variants[parent]) variants[parent] = [];
          variants[parent].push(obj);
        }
      } catch (e) {
      }
    });
    
    if (isDone) break;
    startByte = nextStart;
  }
  
  Logger.log(`  ${totalLinesParsed} lines downloaded and parsed.`);
  
  // ---------------------------------------------------------
  // Prepare data for Sheet
  // ---------------------------------------------------------
  const finalHeaders = [
    "custom_good_id",
    "Variant SKU",
    "Product GID",
    "Variant GID",
    "Price",
    "Compare At Price"
  ];
  
  const finalRows2D = [finalHeaders];
  
  Object.keys(products).forEach(pid => {
    const p = products[pid];
    const goodIdRaw = p.custom_good_id || "";
    
    // Parse goodId to number if possible to match format
    let goodId = goodIdRaw;
    if (goodIdRaw) {
      const parsed = parseInt(goodIdRaw, 10);
      goodId = isNaN(parsed) ? goodIdRaw : parsed;
    }
    
    const pVariants = variants[pid] || [];
    
    pVariants.forEach(v => {
      finalRows2D.push([
        goodId,
        v.sku || "",
        pid,
        v.id || "",
        v.price != null ? v.price : "",
        v.compareAtPrice != null ? v.compareAtPrice : ""
      ]);
    });
  });
  
  Logger.log(`  ${finalRows2D.length - 1} variants mapped.`);
  
  // ---------------------------------------------------------
  // Write to Target Sheet
  // ---------------------------------------------------------
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(TARGET_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TARGET_SHEET_NAME);
  } else {
    sheet.clear();
  }
  
  const targetRows = finalRows2D.length;
  const targetCols = finalHeaders.length;
  
  const currentRows = sheet.getMaxRows();
  const currentCols = sheet.getMaxColumns();
  
  if (currentCols < targetCols) {
    sheet.insertColumnsAfter(currentCols, targetCols - currentCols);
  } else if (currentCols > targetCols) {
    sheet.deleteColumns(targetCols + 1, currentCols - targetCols);
  }
  
  if (currentRows < targetRows) {
    sheet.insertRowsAfter(currentRows, targetRows - currentRows);
  } else if (currentRows > targetRows) {
    sheet.deleteRows(targetRows + 1, currentRows - targetRows);
  }
  
  sheet.getRange(1, 1, targetRows, targetCols).setWrap(false).setValues(finalRows2D);
  sheet.getRange(1, 1, 1, targetCols).setFontWeight("bold");
  sheet.setFrozenRows(1);
  
  Logger.log(`✅ Data written to sheet '${TARGET_SHEET_NAME}'`);
}

// ============================================================
// HELPER: AUTH
// ============================================================
function getAccessToken_() {
  const SHOP = PropertiesService.getScriptProperties().getProperty("SHOP") || "sevenfive-4062.myshopify.com";
  const CLIENT_ID = PropertiesService.getScriptProperties().getProperty("CLIENT_ID") || "696e1e9162c702cc07c2f94a1beacf8a";
  const CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("CLIENT_SECRET");

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
  const SHOP = PropertiesService.getScriptProperties().getProperty("SHOP") || "sevenfive-4062.myshopify.com";
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
