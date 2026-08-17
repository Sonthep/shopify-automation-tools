// ============================================================
// UPDATE SHOPIFY FROM WINSPEED (SELF-CONTAINED MODULE)
// อ่านชีต "data" (หรือชีตที่ระบุ) หาแถวที่ "check update" = UPDATE
// แล้วนำค่าคอลัมน์ *winspeed ไปอัปเดตกลับที่ Shopify:
//   main cat winspeed     -> productType (native field)
//   sub cat winspeed      -> tags (native field)
//   product type winspeed -> metafield custom.part_type
//   power type winspeed   -> metafield custom.power_type
// ============================================================
function updateMetafieldFromWinspeed(sheetName) {
  const SHEET_NAME = sheetName || "data";
  const LOG_SHEET_NAME = "Logrun script";
  const STATUS_HEADER = "Update Status";

  const SHOP = PropertiesService.getScriptProperties().getProperty("SHOP") || "sevenfive-4062.myshopify.com";
  const CLIENT_ID = PropertiesService.getScriptProperties().getProperty("CLIENT_ID") || "696e1e9162c702cc07c2f94a1beacf8a";
  const CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("CLIENT_SECRET");

  const PROP_ACCESS_TOKEN = "ACCESS_TOKEN";
  const PROP_TOKEN_EXPIRY = "TOKEN_EXPIRY";

  // 1. INNER HELPERS (Zero global leakage)
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

  // มี retry เมื่อโดน THROTTLED หรือ token หมดอายุกลางทาง (401)
  function callGraphQL(payload) {
    let maxRetries = 3;
    let waitMs = 2000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const accessToken = getAccessToken();
      const res = UrlFetchApp.fetch("https://" + SHOP + "/admin/api/2025-01/graphql.json", {
        method: "post",
        contentType: "application/json",
        headers: { "X-Shopify-Access-Token": accessToken },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      const code = res.getResponseCode();
      if (code === 401) {
        PropertiesService.getScriptProperties().deleteProperty(PROP_ACCESS_TOKEN);
        Utilities.sleep(1000);
        continue;
      }
      if (code >= 400) {
        Logger.log("[ERROR] GraphQL HTTP " + code + ": " + res.getContentText().substring(0, 300));
        return null;
      }

      const json = JSON.parse(res.getContentText());
      if (json.errors) {
        const isThrottled = json.errors.every(e => e.extensions && e.extensions.code === "THROTTLED");
        if (isThrottled) {
          Logger.log("[THROTTLED] Retrying in " + waitMs + " ms...");
          Utilities.sleep(waitMs);
          waitMs *= 2;
          continue;
        }
        Logger.log("[ERROR] GraphQL execution errors: " + JSON.stringify(json.errors));
        return null;
      }
      return json;
    }
    return null;
  }

  // ดึง type จริงของ metafield definitions namespace "custom" (fallback เป็น single_line_text_field ถ้าไม่พบ)
  function fetchMetafieldTypes() {
    const query = `{ metafieldDefinitions(first: 250, ownerType: PRODUCT, namespace: "custom") { nodes { namespace key type { name } } } }`;
    const resData = callGraphQL({ query: query });
    const nodes = (resData && resData.data && resData.data.metafieldDefinitions && resData.data.metafieldDefinitions.nodes) || [];
    const map = {};
    nodes.forEach(n => { map[`${n.namespace}.${n.key}`] = n.type.name; });
    return map;
  }

  function updateProduct(productGid, mainCat, subCat, partType, partTypeType, powerType, powerTypeType) {
    const input = { id: productGid };
    if (mainCat) input.productType = mainCat;
    if (subCat) input.tags = subCat.split(",").map(t => t.trim()).filter(Boolean);

    const metafields = [];
    if (partType) metafields.push({ namespace: "custom", key: "part_type", value: partType, type: partTypeType });
    if (powerType) metafields.push({ namespace: "custom", key: "power_type", value: powerType, type: powerTypeType });
    if (metafields.length > 0) input.metafields = metafields;

    const mutation = `mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id }
        userErrors { field message }
      }
    }`;

    return callGraphQL({ query: mutation, variables: { input: input } });
  }

  function logToSheet(statusMsg, updateCount, skipCount, failCount) {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let logSheet = ss.getSheetByName(LOG_SHEET_NAME);
      if (!logSheet) {
        logSheet = ss.insertSheet(LOG_SHEET_NAME);
        logSheet.getRange(1, 1, 1, 5).setValues([["Timestamp", "Status", "Updated", "Skipped", "Failed"]]);
        logSheet.getRange(1, 1, 1, 5).setFontWeight("bold");
        logSheet.setFrozenRows(1);
      }
      const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
      logSheet.appendRow([timestamp, statusMsg, updateCount, skipCount, failCount]);
    } catch (e) {}
  }

  // 2. MAIN FLOW
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    Logger.log("❌ ไม่พบชีต '" + SHEET_NAME + "'");
    return;
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) {
    Logger.log("⚠️ ไม่มีข้อมูลให้อัปเดต");
    return;
  }

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const idx = {
    productGid: headers.indexOf("Product GID"),
    checkUpdate: headers.indexOf("check update"),
    mainCatWinspeed: headers.indexOf("main cat winspeed"),
    subCatWinspeed: headers.indexOf("sub cat winspeed"),
    productTypeWinspeed: headers.indexOf("product type winspeed"),
    powerTypeWinspeed: headers.indexOf("power type winspeed")
  };

  const missing = Object.keys(idx).filter(k => idx[k] === -1);
  if (missing.length > 0) {
    Logger.log("❌ ไม่พบคอลัมน์ที่ต้องใช้ในชีต '" + SHEET_NAME + "': " + missing.join(", "));
    return;
  }

  let statusCol = headers.indexOf(STATUS_HEADER);
  if (statusCol === -1) {
    statusCol = headers.length;
    sheet.getRange(1, statusCol + 1).setValue(STATUS_HEADER).setFontWeight("bold");
  }

  Logger.log("🔎 ดึง metafield definition types สำหรับ namespace 'custom'...");
  const mfTypes = fetchMetafieldTypes();
  const partTypeType = mfTypes["custom.part_type"] || "single_line_text_field";
  const powerTypeType = mfTypes["custom.power_type"] || "single_line_text_field";

  const data = sheet.getRange(2, 1, lastRow - 1, Math.max(lastCol, statusCol + 1)).getValues();
  const statusUpdates = new Array(data.length).fill([""]);

  let updateCount = 0, skipCount = 0, failCount = 0;

  Logger.log("🚀 เริ่มอัปเดต Shopify จากชีต '" + SHEET_NAME + "' (" + data.length + " แถว)...");

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const checkVal = String(row[idx.checkUpdate] || "").trim().toUpperCase();

    if (checkVal !== "UPDATE") {
      statusUpdates[i] = ["⏭️ ข้าม (ไม่ต้องอัปเดต)"];
      skipCount++;
      continue;
    }

    const productGid = String(row[idx.productGid] || "").trim();
    if (!productGid.startsWith("gid://shopify/Product/")) {
      statusUpdates[i] = ["❌ Product GID ไม่ถูกต้อง"];
      failCount++;
      continue;
    }

    const mainCat = String(row[idx.mainCatWinspeed] || "").trim();
    const subCat = String(row[idx.subCatWinspeed] || "").trim();
    const productType = String(row[idx.productTypeWinspeed] || "").trim();
    const powerType = String(row[idx.powerTypeWinspeed] || "").trim();

    if (!mainCat && !subCat && !productType && !powerType) {
      statusUpdates[i] = ["⏭️ ข้าม (ไม่มีค่า winspeed ให้ใช้อัปเดต)"];
      skipCount++;
      continue;
    }

    const resData = updateProduct(productGid, mainCat, subCat, productType, partTypeType, powerType, powerTypeType);
    const result = resData && resData.data && resData.data.productUpdate;

    if (result && result.userErrors && result.userErrors.length > 0) {
      statusUpdates[i] = ["❌ Error: " + result.userErrors.map(e => e.message).join(", ")];
      failCount++;
    } else if (result && result.product) {
      const nowStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");
      statusUpdates[i] = [`✅ อัปเดตสำเร็จ (${nowStr})`];
      updateCount++;
    } else {
      statusUpdates[i] = ["❌ API Error (เชื่อมต่อไม่สำเร็จ)"];
      failCount++;
    }

    Utilities.sleep(150);
  }

  sheet.getRange(2, statusCol + 1, statusUpdates.length, 1).setValues(statusUpdates);

  const summary = `🎉 อัปเดตเสร็จสิ้น: สำเร็จ ${updateCount} รายการ, ข้าม ${skipCount} รายการ, ล้มเหลว ${failCount} รายการ`;
  Logger.log(summary);
  logToSheet(summary, updateCount, skipCount, failCount);
}
