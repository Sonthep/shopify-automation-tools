// ============================================================
// SHOPIFY FILTERED PRODUCTS EXPORT (SELF-CONTAINED MODULE)
// ============================================================

function exportFilterProductsToSheet() {
  // 1. CONFIG & CONSTANTS (Scoped strictly inside exportFilterProductsToSheet)
  const SHOP = PropertiesService.getScriptProperties().getProperty("SHOP") || "sevenfive-4062.myshopify.com";
  const CLIENT_ID = PropertiesService.getScriptProperties().getProperty("CLIENT_ID") || "696e1e9162c702cc07c2f94a1beacf8a";
  const CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("CLIENT_SECRET") || "YOUR_CLIENT_SECRET";
  const EXPORT_SHEET_NAME = "Products Export";
  const POLL_INTERVAL_MS = 10000; 

  const PROP_ACCESS_TOKEN = "ACCESS_TOKEN";
  const PROP_TOKEN_EXPIRY = "TOKEN_EXPIRY";
  const PROP_LAST_BULK_OP_ID = "LAST_BULK_OP_ID_FP";

  // 2. INNER HELPERS (Zero global leakage)
  function getAccessToken() {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty(PROP_ACCESS_TOKEN), expiry = Number(props.getProperty(PROP_TOKEN_EXPIRY) || 0);
    if (token && Date.now() < expiry - 300000) return token;
    const res = UrlFetchApp.fetch("https://" + SHOP + "/admin/oauth/access_token", {
      method: "post", contentType: "application/x-www-form-urlencoded",
      payload: "grant_type=client_credentials&client_id=" + encodeURIComponent(CLIENT_ID) + "&client_secret=" + encodeURIComponent(CLIENT_SECRET),
      muteHttpExceptions: true
    });
    const data = JSON.parse(res.getContentText());
    if (!data.access_token) return null;
    props.setProperty(PROP_ACCESS_TOKEN, data.access_token);
    props.setProperty(PROP_TOKEN_EXPIRY, String(Date.now() + ((Number(data.expires_in) || 3600) * 1000)));
    return data.access_token;
  }

  function callGraphQL(payload) {
    const accessToken = getAccessToken();
    const res = UrlFetchApp.fetch("https://" + SHOP + "/admin/api/2025-01/graphql.json", {
      method: "post", contentType: "application/json", headers: { "X-Shopify-Access-Token": accessToken },
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    return res.getResponseCode() >= 400 ? null : JSON.parse(res.getContentText());
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

    const res = callGraphQL({ query: BULK_MUTATION, variables: { query: INNER_QUERY } });
    if (!res || !res.data || !res.data.bulkOperationRunQuery) return null;
    const opData = res.data.bulkOperationRunQuery;
    if (opData.userErrors && opData.userErrors.length > 0) return null;
    return opData.bulkOperation.id;
  }

  function pollStatusLoop(bulkOperationId, maxPollTimeMs) {
    const payload = {
      query: `query { node(id: "${bulkOperationId}") { ... on BulkOperation { id status errorCode objectCount url } } }`
    };
    const startTime = Date.now();
    while (true) {
      const res = callGraphQL(payload);
      const op = (res && res.data && res.data.node) ? res.data.node : null;
      if (!op) return { status: "NOT_FOUND" };
      Logger.log(`  [${op.status}] ${op.objectCount || 0} objects`);
      if (op.status === "COMPLETED") return { status: "COMPLETED", url: op.url };
      if (op.status === "FAILED" || op.status === "CANCELED") return { status: op.status };
      if (Date.now() - startTime > maxPollTimeMs) return { status: op.status };
      Utilities.sleep(POLL_INTERVAL_MS);
    }
  }

  function getColumnLetter(colNum) {
    let letter = "", temp;
    while (colNum > 0) { temp = (colNum - 1) % 26; letter = String.fromCharCode(65 + temp) + letter; colNum = (colNum - temp - 1) / 26; }
    return letter;
  }

  function downloadAndProcessJSONL(url) {
    Logger.log("Downloading full JSONL directly...");
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() >= 400) return;
    
    const products = {}, variants = {}, meta = {}, productImages = {};
    const lines = res.getContentText().split('\n');
    
    lines.forEach(line => {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);
        const gid = obj.id || "", parent = obj.__parentId || "";
        if (gid.includes("/Product/") && !parent) products[gid] = obj;
        else if (gid.includes("/ProductVariant/") && parent) {
          if (!variants[parent]) variants[parent] = [];
          variants[parent].push(obj);
        } else if ((gid.includes("/ProductImage/") || gid.includes("/Image/")) && parent) {
          if (!productImages[parent]) productImages[parent] = [];
          productImages[parent].push(obj.url);
        } else if (obj.namespace && obj.key && parent) {
          if (!meta[parent]) meta[parent] = {};
          meta[parent][`${obj.namespace}.${obj.key}`] = obj.value;
        }
      } catch(e){}
    });

    const baseHeaders = [
      "Variant SKU", "Product GID", "Variant GID", 
      "Inventory Item ID", "Handle", "Title", "Body (HTML)", "Vendor", 
      "Type", "Tags", "Status", "Published", "Price", "Compare At Price", 
      "Inventory", "Image Src", "Image Preview", "All Images", "SEO Title", "SEO Description", "Category"
    ];
    
    const allRowsData = [];
    const metaKeysSet = new Set();
    
    Object.keys(products).forEach(pid => {
      const p = products[pid], mf = meta[pid] || {}, pVariants = variants[pid] || [{}];
      Object.keys(mf).forEach(k => metaKeysSet.add(k));
      
      pVariants.forEach(v => {
        const vid = v.id || "", inv = (v.inventoryItem && v.inventoryItem.id) ? v.inventoryItem.id : "";
        const vmf = meta[vid] || {}, pImgs = productImages[pid] || [];
        Object.keys(vmf).forEach(k => metaKeysSet.add(k));
        
        const rowObj = {
          "Variant SKU": v.sku || "", "Product GID": pid, "Variant GID": vid,
          "Inventory Item ID": inv, "Handle": p.handle || "", "Title": p.title || "",
          "Body (HTML)": p.descriptionHtml || "", "Vendor": p.vendor || "",
          "Type": p.productType || "", "Tags": (p.tags || []).join(", "),
          "Status": p.status || "", "Published": p.publishedAt ? "TRUE" : "FALSE",
          "Price": v.price != null ? v.price : "", "Compare At Price": v.compareAtPrice != null ? v.compareAtPrice : "",
          "Inventory": v.inventoryQuantity != null ? v.inventoryQuantity : "",
          "Image Src": pImgs.length > 0 ? pImgs[0] : "", "All Images": pImgs.join(", "),
          "SEO Title": (p.seo && p.seo.title) ? p.seo.title : "", "SEO Description": (p.seo && p.seo.description) ? p.seo.description : "",
          "Category": (p.category && p.category.fullName) ? p.category.fullName : ""
        };
        
        let goodId = mf["custom.good_id"];
        rowObj["custom.good_id"] = (goodId != null && !isNaN(parseInt(goodId, 10))) ? parseInt(goodId, 10) : "";
        
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
    allRowsData.forEach((rowObj, index) => {
      const rowIndex = index + 2;
      finalRows2D.push(finalHeaders.map(h => {
        if (h === "Image Preview") {
          const colLetter = getColumnLetter(finalHeaders.indexOf("Image Src") + 1);
          return `=IMAGE(${colLetter}${rowIndex})`;
        }
        return rowObj[h] != null ? rowObj[h] : "";
      }));
    });
    
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ssId = ss.getId();
    let sheet = ss.getSheetByName(EXPORT_SHEET_NAME);
    if (!sheet) { sheet = ss.insertSheet(EXPORT_SHEET_NAME); SpreadsheetApp.flush(); }
    
    const targetRows = finalRows2D.length, targetCols = finalHeaders.length;
    let usedSheetsApi = false;
    
    if (typeof Sheets !== "undefined") {
      try {
        const sheetId = sheet.getSheetId();
        Sheets.Spreadsheets.Values.clear({}, ssId, EXPORT_SHEET_NAME);
        
        const currentMaxRows = sheet.getMaxRows();
        const currentMaxCols = sheet.getMaxColumns();
        
        const requests = [
          { updateSheetProperties: { properties: { sheetId: sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
          { repeatCell: { range: { sheetId: sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: targetCols }, cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: "CLIP" } }, fields: "userEnteredFormat(textFormat,wrapStrategy)" } },
          { repeatCell: { range: { sheetId: sheetId, startRowIndex: 1, endRowIndex: targetRows, startColumnIndex: 0, endColumnIndex: targetCols }, cell: { userEnteredFormat: { wrapStrategy: "CLIP" } }, fields: "userEnteredFormat(wrapStrategy)" } }
        ];
        
        if (currentMaxRows < targetRows) requests.push({ appendDimension: { sheetId: sheetId, dimension: "ROWS", length: targetRows - currentMaxRows } });
        if (currentMaxCols < targetCols) requests.push({ appendDimension: { sheetId: sheetId, dimension: "COLUMNS", length: targetCols - currentMaxCols } });
        
        const imgPreviewIndex = finalHeaders.indexOf("Image Preview");
        if (imgPreviewIndex >= 0) requests.push({ updateDimensionProperties: { range: { sheetId: sheetId, dimension: "COLUMNS", startIndex: imgPreviewIndex, endIndex: imgPreviewIndex + 1 }, properties: { pixelSize: 100 }, fields: "pixelSize" } });
        requests.push({ updateDimensionProperties: { range: { sheetId: sheetId, dimension: "ROWS", startIndex: 1, endIndex: targetRows }, properties: { pixelSize: 100 }, fields: "pixelSize" } });
        
        Sheets.Spreadsheets.batchUpdate({ requests: requests }, ssId);
        
        const API_BATCH_SIZE = 8000;
        for (let i = 0; i < targetRows; i += API_BATCH_SIZE) {
          const chunk = finalRows2D.slice(i, i + API_BATCH_SIZE);
          Sheets.Spreadsheets.Values.update({ values: chunk }, ssId, `${EXPORT_SHEET_NAME}!A${i + 1}`, { valueInputOption: "USER_ENTERED" });
        }
        usedSheetsApi = true;
      } catch (e) {}
    }
    
    if (!usedSheetsApi) {
      sheet.clear();
      const currentRows = sheet.getMaxRows(), currentCols = sheet.getMaxColumns();
      if (currentCols < targetCols) sheet.insertColumnsAfter(currentCols, targetCols - currentCols);
      if (currentRows < targetRows) sheet.insertRowsAfter(currentRows, targetRows - currentRows);
      
      sheet.getRange(1, 1, targetRows, targetCols).setWrap(false);
      sheet.setRowHeight(1, 25);
      if (targetRows > 1) sheet.setRowHeightsForced(2, targetRows - 1, 100);
      const imagePreviewColIndex = finalHeaders.indexOf("Image Preview") + 1;
      if (imagePreviewColIndex > 0) sheet.setColumnWidth(imagePreviewColIndex, 100);
      
      const WRITE_BATCH_SIZE = 10000;
      for (let i = 0; i < targetRows; i += WRITE_BATCH_SIZE) {
        const chunk = finalRows2D.slice(i, i + WRITE_BATCH_SIZE);
        sheet.getRange(i + 1, 1, chunk.length, targetCols).setValues(chunk);
      }
      sheet.getRange(1, 1, 1, targetCols).setFontWeight("bold");
      sheet.setFrozenRows(1);
      SpreadsheetApp.flush();
    }
    Logger.log(`✅ ${allRowsData.length} products exported successfully.`);
  }

  // 3. MAIN EXECUTION FLOW (Inside exportFilterProductsToSheet)
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_LAST_BULK_OP_ID); 
  
  Logger.log("🚀 [Fast-Track Filter] เริ่มกระบวนการดึงข้อมูลแบบ Filter รอบเดียวจบ...");
  
  const checkRes = callGraphQL({ query: `{ currentBulkOperation(type: QUERY) { id status url objectCount } }` });
  const currentOp = (checkRes && checkRes.data) ? checkRes.data.currentBulkOperation : null;
  
  let opId = null;
  if (currentOp && (currentOp.status === "RUNNING" || currentOp.status === "CREATED")) {
    Logger.log("⏳ มี Bulk Operation กำลังทำงานอยู่ (" + currentOp.id + ")");
    opId = currentOp.id;
  } else {
    Logger.log("🚀 เริ่มสั่ง Shopify สร้าง Bulk Query ใหม่...");
    opId = startBulkQuery();
    if (!opId) {
      Logger.log("❌ ไม่สามารถเริ่ม query ได้");
      return;
    }
  }
  
  Logger.log("⏳ กำลังรอ Shopify ทำไฟล์ให้เสร็จ...");
  const result = pollStatusLoop(opId, 300000);
  
  if (result.status === "COMPLETED" && result.url) {
    Logger.log("✅ Shopify ทำไฟล์เสร็จเรียบร้อย! กำลังดาวน์โหลดและเขียนลงชีตด้วย Sheets API...");
    downloadAndProcessJSONL(result.url);
    Logger.log("✅ การดึงข้อมูลสำเร็จเรียบร้อย!");
  } else {
    Logger.log("❌ ไม่สำเร็จ Status: " + result.status);
  }
}
