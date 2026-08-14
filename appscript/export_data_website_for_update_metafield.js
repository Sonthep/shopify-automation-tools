// ============================================================
// TEST MODE — ดึงตัวอย่าง N สินค้าแรกด้วย query ปกติ (first: N)
// ไม่ใช้ Bulk Operation จึงได้ผลลัพธ์ทันที เหมาะสำหรับเทสก่อนรันจริงทั้งร้าน
// เขียนผลลงชีต "data_test" (แยกจากชีต "data" ของเวอร์ชันจริง กันข้อมูลจริงถูกทับ)
// ============================================================
function exportDataWebsiteForUpdateMetafieldTest(limit) {
  const LIMIT = limit || 10;

  const SHOP = PropertiesService.getScriptProperties().getProperty("SHOP") || "sevenfive-4062.myshopify.com";
  const CLIENT_ID = PropertiesService.getScriptProperties().getProperty("CLIENT_ID") || "696e1e9162c702cc07c2f94a1beacf8a";
  const CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("CLIENT_SECRET");

  const EXPORT_SHEET_NAME = "data_test";

  const PROP_ACCESS_TOKEN = "ACCESS_TOKEN";
  const PROP_TOKEN_EXPIRY = "TOKEN_EXPIRY";

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

  function fetchProducts(first) {
    const query = `
    {
      products(first: ${first}) {
        edges {
          node {
            id
            productType
            tags
            goodId: metafield(namespace: "custom", key: "good_id") { value }
            partType: metafield(namespace: "custom", key: "part_type") { value }
            powerType: metafield(namespace: "custom", key: "power_type") { value }
            variants(first: 50) {
              edges { node { id sku } }
            }
          }
        }
      }
    }`;

    const resData = callGraphQL({ query: query });
    if (!resData || !resData.data || !resData.data.products) {
      Logger.log("[ERROR] ดึงสินค้าไม่สำเร็จ: " + JSON.stringify(resData));
      return [];
    }
    return resData.data.products.edges.map(e => e.node);
  }

  const WINSPEED_FILE_ID = "1Z48qT3LXYozhlh_ZBHzn9e4x1kfX_bOLHQtaksj-ZXU";

  // ลำดับคอลัมน์คงที่ A-M: คอลัมน์ที่มี key ดึงจากข้อมูล Shopify, ที่ไม่มี key คือสูตร (เติมทีหลังด้วย applyWinspeedFormulas)
  const COLUMNS = [
    { header: "custom.good_id", key: "custom.good_id" },
    { header: "Variant SKU", key: "Variant SKU" },
    { header: "Product GID", key: "Product GID" },
    { header: "Variant GID", key: "Variant GID" },
    { header: "main cat website", key: "Type" },
    { header: "main cat winspeed" },
    { header: "sub cat website", key: "Tags" },
    { header: "sub cat winspeed" },
    { header: "product type website", key: "custom.part_type" },
    { header: "product type winspeed" },
    { header: "power type website", key: "custom.power_type" },
    { header: "power type winspeed" },
    { header: "check update" }
  ];

  function buildRows(p) {
    let goodId = p.goodId ? p.goodId.value : "";
    if (goodId != null && goodId !== "") {
      const parsed = parseInt(goodId, 10);
      goodId = isNaN(parsed) ? "" : parsed;
    } else {
      goodId = "";
    }

    const partType = p.partType ? p.partType.value : "";
    const powerType = p.powerType ? p.powerType.value : "";
    const type = p.productType || "";
    const tags = (p.tags || []).join(", ");
    const variants = ((p.variants && p.variants.edges) || []).map(e => e.node);

    return (variants.length ? variants : [{}]).map(v => ({
      "custom.good_id": goodId,
      "Variant SKU": v.sku || "",
      "Product GID": p.id,
      "Variant GID": v.id || "",
      "Type": type,
      "Tags": tags,
      "custom.part_type": partType,
      "custom.power_type": powerType
    }));
  }

  // เติมสูตร XLOOKUP เทียบกับชีต "Main Product" (Winspeed) + สูตรเช็คสถานะ column M
  // อ้างอิงตำแหน่งคอลัมน์คงที่ตาม COLUMNS ด้านบน (A, E-M)
  function applyWinspeedFormulas(sheet, numRows) {
    if (numRows <= 0) return;
    const mainCat = [], subCat = [], productType = [], powerType = [], checkUpdate = [];

    for (let i = 0; i < numRows; i++) {
      const r = i + 2;
      mainCat.push([`=XLOOKUP(A${r}, IMPORTRANGE("${WINSPEED_FILE_ID}","Main Product!A:A"), IMPORTRANGE("${WINSPEED_FILE_ID}","Main Product!L:L"))`]);
      subCat.push([`=XLOOKUP(A${r}, IMPORTRANGE("${WINSPEED_FILE_ID}","Main Product!A:A"), IMPORTRANGE("${WINSPEED_FILE_ID}","Main Product!M:M"))`]);
      productType.push([`=XLOOKUP(A${r}, IMPORTRANGE("${WINSPEED_FILE_ID}","Main Product!A:A"), IMPORTRANGE("${WINSPEED_FILE_ID}","Main Product!J:J"))`]);
      powerType.push([`=XLOOKUP(A${r}, IMPORTRANGE("${WINSPEED_FILE_ID}","Main Product!A:A"), IMPORTRANGE("${WINSPEED_FILE_ID}","Main Product!K:K"))`]);
      checkUpdate.push([`=IF(COUNTA(E${r}:L${r})=0,"",IF(AND(LOWER(TRIM(E${r}))=LOWER(TRIM(F${r})),LOWER(TRIM(G${r}))=LOWER(TRIM(H${r})),LOWER(TRIM(I${r}))=LOWER(TRIM(J${r})),LOWER(TRIM(K${r}))=LOWER(TRIM(L${r}))),"OK","UPDATE"))`]);
    }

    sheet.getRange(2, 6, numRows, 1).setFormulas(mainCat);        // F: main cat winspeed
    sheet.getRange(2, 8, numRows, 1).setFormulas(subCat);         // H: sub cat winspeed
    sheet.getRange(2, 10, numRows, 1).setFormulas(productType);   // J: product type winspeed
    sheet.getRange(2, 12, numRows, 1).setFormulas(powerType);     // L: power type winspeed
    sheet.getRange(2, 13, numRows, 1).setFormulas(checkUpdate);   // M: check update
  }

  function writeRowsToSheet(sheetName, rows, columns) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) sheet = ss.insertSheet(sheetName);
    sheet.clear();

    const headers = columns.map(c => c.header);
    const finalRows2D = [headers];
    rows.forEach(rowObj => {
      finalRows2D.push(columns.map(c => (c.key && rowObj[c.key] != null) ? rowObj[c.key] : ""));
    });

    sheet.getRange(1, 1, finalRows2D.length, headers.length).setValues(finalRows2D);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    sheet.setFrozenRows(1);

    applyWinspeedFormulas(sheet, rows.length);
  }

  Logger.log("🧪 เริ่มทดสอบ: ดึงตัวอย่าง " + LIMIT + " สินค้าแรก...");
  const productNodes = fetchProducts(LIMIT);

  const rows = [];
  productNodes.forEach(p => rows.push(...buildRows(p)));

  writeRowsToSheet(EXPORT_SHEET_NAME, rows, COLUMNS);

  const summary = `✅ เทสเสร็จแล้ว | ${productNodes.length} สินค้า | ${rows.length} แถว (variant) เขียนลงชีต '${EXPORT_SHEET_NAME}'`;
  Logger.log(summary);
}

// ============================================================
// SHOPIFY EXPORT FOR METAFIELD UPDATE (SELF-CONTAINED MODULE)
// ดึงข้อมูลสินค้าทั้งหมดจาก Shopify (Bulk Operation) เขียนลงชีต "data"
// เพื่อเตรียมกรอก custom.part_type / custom.power_type แล้วอัปเดตกลับ
// ============================================================
function exportDataWebsiteForUpdateMetafield() {
  // 1. CONFIG & CONSTANTS
  const SHOP = PropertiesService.getScriptProperties().getProperty("SHOP") || "sevenfive-4062.myshopify.com";
  const CLIENT_ID = PropertiesService.getScriptProperties().getProperty("CLIENT_ID") || "696e1e9162c702cc07c2f94a1beacf8a";
  const CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("CLIENT_SECRET");

  const EXPORT_SHEET_NAME = "data";
  const LOG_SHEET_NAME = "Logrun script";
  const POLL_INTERVAL_MS = 10000;
  const WINSPEED_FILE_ID = "1Z48qT3LXYozhlh_ZBHzn9e4x1kfX_bOLHQtaksj-ZXU";

  // ลำดับคอลัมน์คงที่ A-M: คอลัมน์ที่มี key ดึงจากข้อมูล Shopify, ที่ไม่มี key คือสูตร (เติมทีหลังด้วย applyWinspeedFormulas)
  const COLUMNS = [
    { header: "custom.good_id", key: "custom.good_id" },
    { header: "Variant SKU", key: "Variant SKU" },
    { header: "Product GID", key: "Product GID" },
    { header: "Variant GID", key: "Variant GID" },
    { header: "main cat website", key: "Type" },
    { header: "main cat winspeed" },
    { header: "sub cat website", key: "Tags" },
    { header: "sub cat winspeed" },
    { header: "product type website", key: "custom.part_type" },
    { header: "product type winspeed" },
    { header: "power type website", key: "custom.power_type" },
    { header: "power type winspeed" },
    { header: "check update" }
  ];

  const PROP_ACCESS_TOKEN = "ACCESS_TOKEN";
  const PROP_TOKEN_EXPIRY = "TOKEN_EXPIRY";
  const PROP_LAST_BULK_OP_ID = "LAST_BULK_OP_ID_METAFIELD_EXPORT";

  // 2. INNER HELPERS (Zero global leakage)
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

  // Bulk Operation ห้ามใส่ pagination argument (first/after) แม้แต่ใน connection ที่ซ้อนอยู่ข้างใน
  function startBulkQuery() {
    const INNER_QUERY = `
{
  products {
    edges {
      node {
        id
        productType
        tags
        goodId: metafield(namespace: "custom", key: "good_id") { value }
        partType: metafield(namespace: "custom", key: "part_type") { value }
        powerType: metafield(namespace: "custom", key: "power_type") { value }
        variants {
          edges {
            node { id sku }
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

    const resData = callGraphQL({ query: BULK_MUTATION, variables: { query: INNER_QUERY } });
    if (!resData || !resData.data || !resData.data.bulkOperationRunQuery) {
      Logger.log("[ERROR] Failed to start query: " + JSON.stringify(resData));
      return null;
    }

    const runResult = resData.data.bulkOperationRunQuery;
    if (runResult.userErrors && runResult.userErrors.length > 0) {
      Logger.log("[ERROR] " + JSON.stringify(runResult.userErrors));
      return null;
    }
    return runResult.bulkOperation ? runResult.bulkOperation.id : null;
  }

  function pollStatusLoop(bulkOperationId, maxPollTimeMs) {
    maxPollTimeMs = maxPollTimeMs || 300000;
    const query = `{ node(id: "${bulkOperationId}") { ... on BulkOperation { id status url errorCode objectCount } } }`;
    const startTime = Date.now();

    while (true) {
      const resData = callGraphQL({ query: query });
      const op = (resData && resData.data && resData.data.node) ? resData.data.node : null;
      if (!op) return { status: "NOT_FOUND" };

      Logger.log(`  [${op.status}] ${op.objectCount || 0} objects`);
      if (op.status === "COMPLETED") return { status: "COMPLETED", url: op.url, objectCount: op.objectCount };
      if (op.status === "FAILED" || op.status === "CANCELED") return { status: op.status, errorCode: op.errorCode };
      if (Date.now() - startTime > maxPollTimeMs) return { status: op.status, objectCount: op.objectCount };

      Utilities.sleep(POLL_INTERVAL_MS);
    }
  }

  // เติมสูตร XLOOKUP เทียบกับชีต "Main Product" (Winspeed) + สูตรเช็คสถานะ column M
  // อ้างอิงตำแหน่งคอลัมน์คงที่ตาม COLUMNS ด้านบน (A, E-M)
  function applyWinspeedFormulas(sheet, numRows) {
    if (numRows <= 0) return;
    const mainCat = [], subCat = [], productType = [], powerType = [], checkUpdate = [];

    for (let i = 0; i < numRows; i++) {
      const r = i + 2;
      mainCat.push([`=XLOOKUP(A${r}, IMPORTRANGE("${WINSPEED_FILE_ID}","Main Product!A:A"), IMPORTRANGE("${WINSPEED_FILE_ID}","Main Product!L:L"))`]);
      subCat.push([`=XLOOKUP(A${r}, IMPORTRANGE("${WINSPEED_FILE_ID}","Main Product!A:A"), IMPORTRANGE("${WINSPEED_FILE_ID}","Main Product!M:M"))`]);
      productType.push([`=XLOOKUP(A${r}, IMPORTRANGE("${WINSPEED_FILE_ID}","Main Product!A:A"), IMPORTRANGE("${WINSPEED_FILE_ID}","Main Product!J:J"))`]);
      powerType.push([`=XLOOKUP(A${r}, IMPORTRANGE("${WINSPEED_FILE_ID}","Main Product!A:A"), IMPORTRANGE("${WINSPEED_FILE_ID}","Main Product!K:K"))`]);
      checkUpdate.push([`=IF(COUNTA(E${r}:L${r})=0,"",IF(AND(LOWER(TRIM(E${r}))=LOWER(TRIM(F${r})),LOWER(TRIM(G${r}))=LOWER(TRIM(H${r})),LOWER(TRIM(I${r}))=LOWER(TRIM(J${r})),LOWER(TRIM(K${r}))=LOWER(TRIM(L${r}))),"OK","UPDATE"))`]);
    }

    sheet.getRange(2, 6, numRows, 1).setFormulas(mainCat);        // F: main cat winspeed
    sheet.getRange(2, 8, numRows, 1).setFormulas(subCat);         // H: sub cat winspeed
    sheet.getRange(2, 10, numRows, 1).setFormulas(productType);   // J: product type winspeed
    sheet.getRange(2, 12, numRows, 1).setFormulas(powerType);     // L: power type winspeed
    sheet.getRange(2, 13, numRows, 1).setFormulas(checkUpdate);   // M: check update
  }

  function downloadAndProcessJSONL(url) {
    Logger.log("Downloading full JSONL file directly from Shopify...");
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() >= 400) {
      Logger.log("[ERROR] Download JSONL failed (HTTP " + res.getResponseCode() + "): " + res.getContentText().substring(0, 300));
      return;
    }

    const products = {}, variants = {};
    const lines = res.getContentText().split('\n');
    let totalLinesParsed = 0;

    lines.forEach(line => {
      if (!line.trim()) return;
      totalLinesParsed++;
      try {
        const obj = JSON.parse(line);
        const gid = obj.id || "", parent = obj.__parentId || "";

        if (gid.indexOf("/Product/") !== -1 && !parent) {
          products[gid] = obj;
        } else if (gid.indexOf("/ProductVariant/") !== -1 && parent) {
          if (!variants[parent]) variants[parent] = [];
          variants[parent].push(obj);
        }
      } catch (e) {}
    });

    Logger.log(`  ${totalLinesParsed} total JSONL lines downloaded and parsed.`);

    const allRowsData = [];
    Object.keys(products).forEach(pid => {
      const p = products[pid];
      const pVariants = variants[pid] || [{}];

      let goodId = p.goodId ? p.goodId.value : "";
      if (goodId != null && goodId !== "") {
        const parsed = parseInt(goodId, 10);
        goodId = isNaN(parsed) ? "" : parsed;
      } else {
        goodId = "";
      }

      const partType = p.partType ? p.partType.value : "";
      const powerType = p.powerType ? p.powerType.value : "";
      const type = p.productType || "";
      const tags = (p.tags || []).join(", ");

      pVariants.forEach(v => {
        allRowsData.push({
          "custom.good_id": goodId,
          "Variant SKU": v.sku || "",
          "Product GID": pid,
          "Variant GID": v.id || "",
          "Type": type,
          "Tags": tags,
          "custom.part_type": partType,
          "custom.power_type": powerType
        });
      });
    });

    const headers = COLUMNS.map(c => c.header);
    const finalRows2D = [headers];
    allRowsData.forEach(rowObj => {
      finalRows2D.push(COLUMNS.map(c => (c.key && rowObj[c.key] != null) ? rowObj[c.key] : ""));
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
    const targetCols = headers.length;
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

    applyWinspeedFormulas(sheet, allRowsData.length);

    Logger.log(`✅ ${allRowsData.length} rows exported to sheet '${EXPORT_SHEET_NAME}'`);
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
      const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
      const method = usedSheetsApi ? "Sheets API" : "setValues";
      logSheet.appendRow([timestamp, "✅ Success", rowCount, method]);
    } catch (e) {}
  }

  // 3. MAIN EXECUTION FLOW
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_LAST_BULK_OP_ID);

  Logger.log("🚀 เริ่มดึงข้อมูลสินค้าทั้งหมดจาก Shopify สำหรับเตรียมอัปเดต metafield...");

  const checkRes = callGraphQL({ query: `{ currentBulkOperation(type: QUERY) { id status url objectCount } }` });
  const currentOp = (checkRes && checkRes.data) ? checkRes.data.currentBulkOperation : null;

  let opId = null;
  if (currentOp && (currentOp.status === "RUNNING" || currentOp.status === "CREATED")) {
    Logger.log("⏳ พบ Bulk Operation ที่กำลังทำงานอยู่ (" + currentOp.id + ") — จะรอตัวนี้แทนการเริ่มใหม่...");
    opId = currentOp.id;
  } else {
    opId = startBulkQuery();
    if (!opId) {
      Logger.log("❌ ไม่สามารถเริ่ม bulk query ได้ โปรดตรวจสอบ Log");
      return;
    }
  }

  Logger.log("⏳ กำลังรอ Shopify ประมวลผล Bulk Operation...");
  const result = pollStatusLoop(opId, 600000);

  if (result.status !== "COMPLETED" || !result.url) {
    Logger.log("❌ Bulk operation ล้มเหลวหรือหมดเวลา: " + JSON.stringify(result));
    return;
  }

  Logger.log("✅ Bulk operation เสร็จสมบูรณ์ (" + result.objectCount + " objects) กำลังดาวน์โหลดและเขียนลงชีตทันที...");
  downloadAndProcessJSONL(result.url);
}
