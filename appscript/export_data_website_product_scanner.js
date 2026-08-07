// ============================================================
// SHOPIFY PRODUCT SCANNER EXPORT (SELF-CONTAINED MODULE)
// Target Columns: custom.good_id, Variant SKU, Title, Price, include vat 7%, vendor, Image URL, Handle
// ============================================================

function exportDataWebsiteProductScanner() {
  // 1. CONFIG & CONSTANTS
  const SHOP = PropertiesService.getScriptProperties().getProperty("SHOP") || "sevenfive-4062.myshopify.com";
  const CLIENT_ID = PropertiesService.getScriptProperties().getProperty("CLIENT_ID") || "696e1e9162c702cc07c2f94a1beacf8a";
  const CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("CLIENT_SECRET") || "YOUR_CLIENT_SECRET";
  const EXPORT_SHEET_NAME = "Products2";
  const LOG_SHEET_NAME = "Logrun script";
  const POLL_INTERVAL_MS = 10000;

  const PROP_ACCESS_TOKEN = "ACCESS_TOKEN";
  const PROP_TOKEN_EXPIRY = "TOKEN_EXPIRY";
  const PROP_LAST_BULK_OP_ID = "LAST_BULK_OP_ID_SCANNER";

  // Firestore project config (same Firebase project as frontend)
  const FIRESTORE_PROJECT_ID = "sevenfive-product-scanner";
  const FIRESTORE_COLLECTION = "products";

  // 2. INNER HELPERS
  function getAccessToken() {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty(PROP_ACCESS_TOKEN);
    const expiry = Number(props.getProperty(PROP_TOKEN_EXPIRY) || 0);

    if (token && Date.now() < expiry - 300000) return token;

    Logger.log("Token expired or not found. Requesting new token...");
    const res = UrlFetchApp.fetch("https://" + SHOP + "/admin/oauth/access_token", {
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

  function callGraphQL(payload) {
    const accessToken = getAccessToken();
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

  function startBulkQuery() {
    const INNER_QUERY = `
{
  products(query: "metafields.custom.spapart_or_product:สินค้า") {
    edges {
      node {
        id
        handle
        title
        vendor
        variants {
          edges {
            node {
              id
              sku
            }
          }
        }
        images {
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

    const payload = { query: BULK_MUTATION, variables: { query: INNER_QUERY } };
    const res = callGraphQL(payload);
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

  function pollStatusLoop(bulkOperationId, maxPollTimeMs) {
    maxPollTimeMs = maxPollTimeMs || 300000;
    const payload = {
      query: `query { node(id: "${bulkOperationId}") { ... on BulkOperation { id status errorCode objectCount url } } }`
    };
    
    const startTime = Date.now();
    while (true) {
      const res = callGraphQL(payload);
      const op = (res && res.data && res.data.node) ? res.data.node : null;
      if (!op) {
        Logger.log("[ERROR] Bulk operation not found for ID: " + bulkOperationId);
        return { status: "NOT_FOUND" };
      }
      
      Logger.log(`  [${op.status}] ${op.objectCount || 0} objects`);
      if (op.status === "COMPLETED") return { status: "COMPLETED", url: op.url, objectCount: op.objectCount };
      if (op.status === "FAILED" || op.status === "CANCELED") return { status: op.status, errorCode: op.errorCode };
      if (Date.now() - startTime > maxPollTimeMs) return { status: op.status, objectCount: op.objectCount };
      
      Utilities.sleep(POLL_INTERVAL_MS);
    }
  }

  function downloadAndProcessJSONL(url) {
    Logger.log("Downloading full JSONL file directly from Shopify...");
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() >= 400) {
      Logger.log("[ERROR] Download JSONL failed (HTTP " + res.getResponseCode() + "): " + res.getContentText().substring(0, 300));
      return;
    }
    
    const products = {}, variants = {}, meta = {}, productImages = {};
    const lines = res.getContentText().split('\n');
    let totalLinesParsed = 0;
    
    lines.forEach(line => {
      if (!line.trim()) return;
      totalLinesParsed++;
      try {
        const obj = JSON.parse(line);
        const gid = obj.id || "", parent = obj.__parentId || "";
        
        if (gid.indexOf("/Product/") !== -1 && !parent) products[gid] = obj;
        else if (gid.indexOf("/ProductVariant/") !== -1 && parent) {
          if (!variants[parent]) variants[parent] = [];
          variants[parent].push(obj);
        } else if ((gid.indexOf("/ProductImage/") !== -1 || gid.indexOf("/Image/") !== -1) && parent) {
          if (!productImages[parent]) productImages[parent] = [];
          productImages[parent].push(obj.url);
        } else if (obj.namespace && obj.key && parent) {
          if (!meta[parent]) meta[parent] = {};
          meta[parent][`${obj.namespace}.${obj.key}`] = obj.value;
        }
      } catch (e) {}
    });
    
    Logger.log(`  ${totalLinesParsed} total JSONL lines downloaded and parsed.`);
    
    // เรียงลำดับ Column ตามสั่ง: custom.good_id, SKU, Title, Price, include vat 7%, vendor, Image URL, Handle
    const finalHeaders = [
      "custom.good_id",
      "SKU",
      "Title",
      "Price",
      "include vat 7%",
      "vendor",
      "Image URL",
      "Handle"
    ];
    
    const allRowsData = [];
    Object.keys(products).forEach(pid => {
      const p = products[pid];
      const mf = meta[pid] || {};
      
      const spVal = mf["custom.spapart_or_product"];
      if (spVal && spVal !== "สินค้า") return;
      
      const pVariants = variants[pid] || [{}];
      const pImgs = productImages[pid] || [];
      const imageUrl = pImgs.length > 0 ? pImgs[0] : "";
      
      let rawGoodId = mf["custom.good_id"];
      let goodId = "";
      if (rawGoodId != null && rawGoodId !== "") {
        let parsed = parseInt(rawGoodId, 10);
        goodId = isNaN(parsed) ? "" : parsed;
      }
      
      pVariants.forEach(v => {
        const vid = v.id || "";
        const vmf = meta[vid] || {};
        
        let variantGoodId = vmf["custom.good_id"];
        let finalGoodId = goodId;
        if (variantGoodId != null && variantGoodId !== "") {
          let parsedV = parseInt(variantGoodId, 10);
          if (!isNaN(parsedV)) finalGoodId = parsedV;
        }
        
        const rowObj = {
          "custom.good_id": finalGoodId,
          "SKU": v.sku || "",
          "Title": p.title || "",
          "Price": "",           // value ว่างไว้ก่อน
          "include vat 7%": "",  // value ว่างไว้ก่อน
          "vendor": p.vendor || "",
          "Image URL": imageUrl,
          "Handle": p.handle || ""
        };
        
        allRowsData.push(rowObj);
      });
    });
    
    const finalRows2D = [finalHeaders];
    allRowsData.forEach(rowObj => {
      finalRows2D.push(finalHeaders.map(h => rowObj[h] != null ? rowObj[h] : ""));
    });
    
    Logger.log(`  ${allRowsData.length} variant rows assembled.`);
    
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
          { updateSheetProperties: { properties: { sheetId: sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
          { repeatCell: { range: { sheetId: sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: targetCols }, cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: "CLIP" } }, fields: "userEnteredFormat(textFormat,wrapStrategy)" } }
        ];

        if (currentMaxRows < targetRows) {
          requests.push({ appendDimension: { sheetId: sheetId, dimension: "ROWS", length: targetRows - currentMaxRows } });
        }

        Sheets.Spreadsheets.batchUpdate({ requests: requests }, ssId);
        
        const API_BATCH_SIZE = 8000;
        for (let i = 0; i < targetRows; i += API_BATCH_SIZE) {
          const chunk = finalRows2D.slice(i, i + API_BATCH_SIZE);
          Sheets.Spreadsheets.Values.update({ values: chunk }, ssId, `${EXPORT_SHEET_NAME}!A${i + 1}`, { valueInputOption: "RAW" });
        }
        
        usedSheetsApi = true;
      } catch (apiErr) {
        Logger.log("  [WARN] Sheets API failed (" + apiErr.message + ") — falling back...");
      }
    }
    
    if (!usedSheetsApi) {
      sheet.setRowHeight(1, 25);
      sheet.setFrozenRows(1);
      sheet.clearContents();
      const currentRows = sheet.getMaxRows();
      if (currentRows < targetRows) sheet.insertRowsAfter(currentRows, targetRows - currentRows);
      
      const WRITE_BATCH_SIZE = 10000;
      for (let i = 0; i < targetRows; i += WRITE_BATCH_SIZE) {
        const chunk = finalRows2D.slice(i, i + WRITE_BATCH_SIZE);
        sheet.getRange(i + 1, 1, chunk.length, targetCols).setValues(chunk);
      }
      sheet.getRange(1, 1, 1, targetCols).setFontWeight("bold").setWrap(false);
      SpreadsheetApp.flush();
    }
    
    Logger.log(`✅ ${allRowsData.length} products exported to sheet '${EXPORT_SHEET_NAME}'`);
    logToSheet(allRowsData.length, usedSheetsApi);
  }

  function logToSheet(rowCount, usedSheetsApi) {
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
      logSheet.appendRow([timestamp, "✅ Website Product Scanner Success", rowCount, method]);
    } catch (e) {}
  }

  function showAlert(message) {
    Logger.log("ALERT: " + message);
  }

  // 3. MAIN EXECUTION FLOW
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_LAST_BULK_OP_ID);
  
  Logger.log("🚀 Starting export for Website Product Scanner...");
  
  const checkRes = callGraphQL({ query: `{ currentBulkOperation(type: QUERY) { id status url objectCount } }` });
  const currentOp = (checkRes && checkRes.data) ? checkRes.data.currentBulkOperation : null;
  
  let opId = null;
  if (currentOp && (currentOp.status === "RUNNING" || currentOp.status === "CREATED")) {
    Logger.log("⏳ Active Bulk Operation detected (" + currentOp.id + ") — waiting...");
    opId = currentOp.id;
  } else {
    Logger.log("🚀 Starting fresh bulk query for Product Scanner...");
    opId = startBulkQuery();
    if (!opId) {
      showAlert("❌ ไม่สามารถเริ่ม query ได้ โปรดตรวจสอบ Log");
      return;
    }
  }
  
  Logger.log("⏳ Waiting for Shopify bulk operation...");
  const result = pollStatusLoop(opId, 300000);
  
  if (result.status === "COMPLETED" && result.url) {
    Logger.log("✅ Bulk operation complete. Downloading and writing to sheet...");
    downloadAndProcessJSONL(result.url);
    showAlert("✅ Export Product Scanner สำเร็จเรียบร้อย!");
  } else {
    Logger.log("❌ Bulk operation failed or timed out: " + JSON.stringify(result));
    showAlert("❌ ดึงข้อมูลไม่สำเร็จ Status: " + result.status);
  }
}


// ============================================================
// FIRESTORE SYNC (Standalone Module)
// ============================================================

function onOpenProductScanner() {
  SpreadsheetApp.getUi()
    .createMenu("🔥 Firestore Sync")
    .addItem("Sync 'Products' sheet to Firestore", "syncProductsSheetToFirestore")
    .addToUi();
}

// Uses OAuth2 service account token from Apps Script runtime
function getFirestoreTokenScanner() {
  return ScriptApp.getOAuthToken();
}

function syncProductsSheetToFirestore() {
  const FIRESTORE_PROJECT_ID = "sevenfive-product-scanner";
  const FIRESTORE_COLLECTION = "products";
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const productSheet = ss.getSheetByName("Products") || ss.getSheets()[0];
  if (!productSheet) {
    Logger.log("❌ ไม่พบชีต Products");
    SpreadsheetApp.getUi().alert("ไม่พบชีต Products");
    return;
  }
  
  const data = productSheet.getDataRange().getValues();
  if (data.length <= 1) {
    Logger.log("❌ ไม่มีข้อมูลในชีต Products");
    return;
  }
  
  const headers = data[0];
  let skuIndex = -1, handleIndex = -1;
  
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i]).trim().toLowerCase();
    if (h === "sku" || h === "รหัสสินค้า") skuIndex = i;
    else if (h === "handle" || h === "slug") handleIndex = i;
  }
  if (skuIndex === -1) skuIndex = 0; // Default to first col
  
  const allRowsData = [];
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const rowSku = String(row[skuIndex] || "").trim();
    if (!rowSku) continue;
    
    let foundItem = { SKU: rowSku };
    for (let c = 0; c < headers.length; c++) {
      const key = String(headers[c]).trim();
      const lowerKey = key.toLowerCase();
      const val = String(row[c] || "");
      
      foundItem[key] = val;
      if (lowerKey === "title" || lowerKey === "name" || lowerKey === "ชื่อสินค้า") foundItem["Title"] = val;
      if (lowerKey === "brand" || lowerKey === "แบรนด์" || lowerKey === "vendor") foundItem["vendor"] = val;
      if (lowerKey === "price" || lowerKey === "ราคา") foundItem["Price"] = val;
      if (lowerKey === "image" || lowerKey === "imageurl" || lowerKey === "รูปภาพ" || lowerKey === "image url") foundItem["Image URL"] = val;
      if (lowerKey.indexOf("vat") !== -1) foundItem["include vat 7%"] = val;
      if (lowerKey === "handle" || lowerKey === "slug") foundItem["Handle"] = val;
    }
    allRowsData.push(foundItem);
  }
  
  Logger.log(`🔥 Starting Firestore sync for ${allRowsData.length} items from Products sheet...`);
  
  const token = getFirestoreTokenScanner();
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents`;
  const BATCH_SIZE = 500;
  let totalSynced = 0;
  let totalErrors = 0;

  for (let i = 0; i < allRowsData.length; i += BATCH_SIZE) {
    const chunk = allRowsData.slice(i, i + BATCH_SIZE);
    
    const writes = chunk.map(row => {
      const sku = row["SKU"];
      const encodedSku = encodeURIComponent(sku);
      const docPath = `projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/${FIRESTORE_COLLECTION}/${encodedSku}`;
      
      const fields = {
        sku:      { stringValue: sku },
        title:    { stringValue: String(row["Title"] || "") },
        price:    { stringValue: String(row["Price"] || "") },
        includeVat: { stringValue: String(row["include vat 7%"] || "") },
        vendor:   { stringValue: String(row["vendor"] || "") },
        imageUrl: { stringValue: String(row["Image URL"] || "") },
        handle:   { stringValue: String(row["Handle"] || "") },
        goodId:   { stringValue: String(row["custom.good_id"] || "") },
        updatedAt: { timestampValue: new Date().toISOString() }
      };
      
      return { update: { name: docPath, fields: fields } };
    });

    try {
      const payload = JSON.stringify({ writes: writes });
      const res = UrlFetchApp.fetch(`${baseUrl}:batchWrite`, {
        method: "post",
        contentType: "application/json",
        headers: { "Authorization": "Bearer " + token },
        payload: payload,
        muteHttpExceptions: true
      });

      if (res.getResponseCode() >= 400) {
        Logger.log(`[Firestore] batchWrite chunk ${i}-${i + chunk.length} FAILED: HTTP ${res.getResponseCode()}: ${res.getContentText().substring(0, 200)}`);
        totalErrors += writes.length;
      } else {
        totalSynced += writes.length;
        Logger.log(`[Firestore] Synced chunk ${i+1}-${i + writes.length} (${writes.length} docs)`);
      }
    } catch (err) {
      Logger.log("[Firestore] batchWrite error: " + err.message);
      totalErrors += writes.length;
    }
    
    if (i + BATCH_SIZE < allRowsData.length) {
      Utilities.sleep(200);
    }
  }

  Logger.log(`✅ Firestore sync done: ${totalSynced} synced, ${totalErrors} errors`);
  
  try {
    let logSheet = ss.getSheetByName("Logrun script");
    if (logSheet) {
      const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
      logSheet.appendRow([timestamp, `🔥 Firestore sync (Products sheet): ${totalSynced} synced, ${totalErrors} errors`, totalSynced, "Firestore REST API"]);
    }
    SpreadsheetApp.getUi().alert(`✅ Firestore Sync เสร็จสมบูรณ์!\nซิงค์สำเร็จ: ${totalSynced} รายการ\nผิดพลาด: ${totalErrors} รายการ`);
  } catch (e) {}
}
