// ============================================================
// SHOPIFY PRODUCT DATA EXPORT (SELF-CONTAINED MODULE)
// Target Sheet: "web sevenfive data"
// ============================================================

function exportProductDataProduct() {
  // 1. CONFIG & CONSTANTS (Scoped strictly inside exportProductDataProduct)
  const SHOP = PropertiesService.getScriptProperties().getProperty("SHOP") || "sevenfive-4062.myshopify.com";
  const CLIENT_ID = PropertiesService.getScriptProperties().getProperty("CLIENT_ID") || "696e1e9162c702cc07c2f94a1beacf8a";
  const CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("CLIENT_SECRET") || "YOUR_CLIENT_SECRET";
  const EXPORT_SHEET_NAME = "web sevenfive data";
  const LOG_SHEET_NAME = "Logrun script";
  const POLL_INTERVAL_MS = 10000;

  const PROP_ACCESS_TOKEN = "ACCESS_TOKEN";
  const PROP_TOKEN_EXPIRY = "TOKEN_EXPIRY";
  const PROP_LAST_BULK_OP_ID = "LAST_BULK_OP_ID_PRODUCT_DATA";

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

  function startBulkQuery() {
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

    const resData = callGraphQL({
      query: BULK_MUTATION,
      variables: { query: INNER_QUERY }
    });

    if (!resData || !resData.data || !resData.data.bulkOperationRunQuery) return null;
    const runResult = resData.data.bulkOperationRunQuery;
    if (runResult.userErrors && runResult.userErrors.length > 0) return null;
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

  function downloadAndProcessJSONL(url) {
    Logger.log("Downloading full JSONL file directly...");
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() >= 400) {
      Logger.log("[ERROR] Download JSONL failed (HTTP " + res.getResponseCode() + ")");
      return;
    }

    const products = {}, variants = {}, meta = {}, productVideos = {};
    const lines = res.getContentText().split('\n');
    let totalLinesParsed = 0;

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
          if (obj.originUrl) videoUrl = obj.originUrl;
          else if (obj.embedUrl) videoUrl = obj.embedUrl;
          else if (obj.sources && obj.sources.length > 0 && obj.sources[0].url) videoUrl = obj.sources[0].url;

          if (videoUrl) {
            if (!productVideos[parent]) productVideos[parent] = [];
            if (productVideos[parent].indexOf(videoUrl) === -1) {
              productVideos[parent].push(videoUrl);
            }
          }
        }
      } catch (e) {}
    });

    Logger.log(`  ${totalLinesParsed} lines downloaded and parsed.`);

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

      const spVal = mf["custom.spapart_or_product"];
      if (spVal && spVal !== "สินค้า") return;

      const pVariants = variants[pid] || [{}];
      const pVideos = productVideos[pid] || [];
      const videoStr = pVideos.join(", ");

      let goodId = mf["custom.good_id"];
      if (goodId != null && goodId !== "") {
        let parsed = parseInt(goodId, 10);
        goodId = isNaN(parsed) ? "" : parsed;
      } else {
        goodId = "";
      }

      const userManual = mf["custom.user_manual"] || mf["custom.manual"] || mf["custom.user_manual_url"] || "";
      const datasheet = mf["custom.datasheet"] || mf["custom.datasheet_url"] || "";
      const linkPdf = mf["custom.link_pdf"] || mf["custom.pdf_link"] || mf["custom.link_pdf_url"] || "";
      const bodyHtml = p.descriptionHtml || "";
      const status = p.status || "";

      pVariants.forEach(v => {
        const sku = v.sku || "";
        allRowsData.push({
          "custom.good_id": goodId,
          "Variant SKU": sku,
          "Body (HTML)": bodyHtml,
          "Status": status,
          "media video": videoStr,
          "User Manual": userManual,
          "Datasheet": datasheet,
          "LInk pdf": linkPdf
        });
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
          {
            updateSheetProperties: {
              properties: { sheetId: sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: "gridProperties.frozenRowCount"
            }
          }
        ];

        if (currentMaxRows < targetRows) {
          requests.push({ appendDimension: { sheetId: sheetId, dimension: "ROWS", length: targetRows - currentMaxRows } });
        }

        Sheets.Spreadsheets.batchUpdate({ requests: requests }, ssId);

        const BATCH_SIZE_ROWS = 8000;
        for (let i = 0; i < finalRows2D.length; i += BATCH_SIZE_ROWS) {
          const chunk2D = finalRows2D.slice(i, i + BATCH_SIZE_ROWS);
          const startRow = i + 1;
          Sheets.Spreadsheets.Values.update(
            { values: chunk2D },
            ssId,
            `${EXPORT_SHEET_NAME}!A${startRow}`,
            { valueInputOption: "RAW" }
          );
        }

        usedSheetsApi = true;
        Logger.log(`  ✅ Done writing ${targetRows} rows with Sheets API.`);
      } catch (apiErr) {
        Logger.log("  [WARN] Sheets API failed (" + apiErr.message + "), falling back...");
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
        sheet.getRange(i + 1, 1, chunk2D.length, targetCols).setValues(chunk2D);
      }
      sheet.setFrozenRows(1);
    }

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
      
      logSheet.appendRow([timestamp, "✅ Product Data Success", rowCount, method]);
      Logger.log("[LOG] บันทึก Log ลงชีทเรียบร้อย: " + timestamp + " | " + rowCount + " rows");
    } catch (logErr) {
      Logger.log("[WARN] ไม่สามารถบันทึก Log ลงชีทได้: " + logErr.message);
    }
  }

  function showAlert(message) {
    Logger.log("ALERT: " + message);
  }

  // 3. MAIN EXECUTION FLOW (Inside exportProductDataProduct)
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_LAST_BULK_OP_ID);

  Logger.log("🚀 Starting export for Product Data ('web sevenfive data')...");

  const checkRes = callGraphQL({ query: `{ currentBulkOperation(type: QUERY) { id status url objectCount } }` });
  const currentOp = (checkRes && checkRes.data) ? checkRes.data.currentBulkOperation : null;

  let opId = null;
  if (currentOp && (currentOp.status === "RUNNING" || currentOp.status === "CREATED")) {
    Logger.log("⏳ Active Bulk Operation detected (" + currentOp.id + ") — waiting...");
    opId = currentOp.id;
  } else {
    Logger.log("🚀 Starting fresh bulk query for Product Data...");
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
    showAlert("✅ Export Product Data (สินค้า) สำเร็จลงชีท 'web sevenfive data' เรียบร้อย!");
  } else {
    Logger.log("❌ Bulk operation failed or timed out: " + JSON.stringify(result));
    showAlert("❌ ดึงข้อมูลไม่สำเร็จ Status: " + result.status);
  }
}
