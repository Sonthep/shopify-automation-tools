// ============================================================
// SHOPIFY PRODUCT CHECK & SPLIT EXPORT (SELF-CONTAINED MODULE)
// แยกข้อมูลสินค้าลง 2 ชีท ตาม custom.spapart_or_product:
//   - "สินค้า"                          -> ชีท "product"
//   - "อะไหล่ หรือ สินค้าสิ้นเปลือง"       -> ชีท "sparepart"
// รวมรูปภาพทุกรูป (Image Src ตัวแรก + All Images รวมทั้งหมด)
// ============================================================

/**
 * TEST MODE — ดึงตัวอย่างจากทั้ง 2 หมวดแยกกัน (ไม่ใช้ Bulk Operation)
 * ใช้ query ปกติ (first: N) เพราะได้ผลลัพธ์ทันที ไม่ต้องรอ poll เหมือน Bulk Operation
 * (Bulk Operation ใส่ first จำกัดจำนวนไม่ได้ ดึงมาทั้งหมดเสมอ จึงไม่เหมาะกับการเทส)
 *
 * @param {number} perCategoryLimit จำนวนสินค้าต่อหมวดที่จะดึงมาเทส (ค่าเริ่มต้น 5 ต่อหมวด)
 */
function exportProductForCheckDataTest(perCategoryLimit) {
  const LIMIT = perCategoryLimit || 5;

  // 1. CONFIG & CONSTANTS
  const SHOP = PropertiesService.getScriptProperties().getProperty("SHOP") || "sevenfive-4062.myshopify.com";
  const CLIENT_ID = PropertiesService.getScriptProperties().getProperty("CLIENT_ID") || "696e1e9162c702cc07c2f94a1beacf8a";
  const CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("CLIENT_SECRET");

  const SHEET_PRODUCT = "product";
  const SHEET_SPAREPART = "sparepart";
  const LOG_SHEET_NAME = "Logrun script";

  const PROP_ACCESS_TOKEN = "ACCESS_TOKEN";
  const PROP_TOKEN_EXPIRY = "TOKEN_EXPIRY";

  const VALUE_PRODUCT = "สินค้า";
  const VALUE_SPAREPART_LIST = ["อะไหล่", "สินค้าสิ้นเปลือง"]; // 2 ค่าแยกกัน ไม่ใช่สตริงเดียว (อ้างอิง get_inventory_web_stock_new.js)

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

  // ดึงสินค้าแบบ query ปกติ (sync, มี first จำกัดจำนวนได้) กรองด้วยค่า custom.spapart_or_product
  // categoryValues รับได้ทั้งสตริงเดียว หรือ array ของค่าที่ยอมรับได้หลายค่า (เชื่อมด้วย OR)
  function fetchProductsByCategory(categoryValues, first) {
    const values = Array.isArray(categoryValues) ? categoryValues : [categoryValues];
    const searchFilter = values
      .map(v => `metafields.custom.spapart_or_product:'${v}'`)
      .join(" OR ");

    const query = `
    {
      products(first: ${first}, query: "${searchFilter}") {
        edges {
          node {
            id
            status
            vendor
            descriptionHtml
            spVal: metafield(namespace: "custom", key: "spapart_or_product") { value }
            goodId: metafield(namespace: "custom", key: "good_id") { value }
            userManual: metafield(namespace: "custom", key: "user_manual") { value }
            datasheet: metafield(namespace: "custom", key: "datasheet") { value }
            linkPdf: metafield(namespace: "custom", key: "link_pdf") { value }
            variants(first: 50) {
              edges { node { id sku } }
            }
            images(first: 250) {
              edges { node { url } }
            }
            media(first: 20) {
              edges {
                node {
                  mediaContentType
                  ... on ExternalVideo { originUrl embedUrl }
                  ... on Video { sources { url } }
                }
              }
            }
          }
        }
      }
    }`;

    const resData = callGraphQL({ query: query });
    if (!resData || !resData.data || !resData.data.products) {
      Logger.log("[ERROR] ดึงสินค้าหมวด '" + values.join(", ") + "' ไม่สำเร็จ: " + JSON.stringify(resData));
      return [];
    }
    return resData.data.products.edges.map(e => e.node);
  }

  function buildRows(productNode) {
    const images = ((productNode.images && productNode.images.edges) || [])
      .map(e => e.node.url)
      .filter(Boolean);

    const videos = [];
    ((productNode.media && productNode.media.edges) || []).forEach(e => {
      const n = e.node;
      let videoUrl = "";
      if (n.originUrl) videoUrl = n.originUrl;
      else if (n.embedUrl) videoUrl = n.embedUrl;
      else if (n.sources && n.sources.length > 0 && n.sources[0].url) videoUrl = n.sources[0].url;
      if (videoUrl && videos.indexOf(videoUrl) === -1) videos.push(videoUrl);
    });

    const variants = ((productNode.variants && productNode.variants.edges) || []).map(e => e.node);
    const spVal = productNode.spVal ? productNode.spVal.value : "";

    let goodId = productNode.goodId ? productNode.goodId.value : "";
    if (goodId != null && goodId !== "") {
      const parsed = parseInt(goodId, 10);
      goodId = isNaN(parsed) ? "" : parsed;
    } else {
      goodId = "";
    }

    const userManual = productNode.userManual ? productNode.userManual.value : "";
    const datasheet = productNode.datasheet ? productNode.datasheet.value : "";
    const linkPdf = productNode.linkPdf ? productNode.linkPdf.value : "";
    const bodyHtml = productNode.descriptionHtml || "";
    const status = productNode.status || "";
    const vendor = productNode.vendor || "";

    return (variants.length ? variants : [{}]).map(v => ({
      "custom.good_id": goodId,
      "Variant SKU": v.sku || "",
      "Body (HTML)": bodyHtml,
      "Status": status,
      "custom.spapart_or_product": spVal,
      "Vendor": vendor,
      "Image Src": images[0] || "",
      "All Images": images.join(", "),
      "media video": videos.join(", "),
      "User Manual": userManual,
      "Datasheet": datasheet,
      "LInk pdf": linkPdf
    }));
  }

  const FULL_HEADERS = [
    "custom.good_id",
    "Variant SKU",
    "Body (HTML)",
    "Status",
    "custom.spapart_or_product",
    "Vendor",
    "Image Src",
    "image preview",
    "All Images",
    "Image count",
    "media video",
    "User Manual",
    "Datasheet",
    "LInk pdf"
  ];

  const SPAREPART_HEADERS = [
    "custom.good_id",
    "Variant SKU",
    "Status",
    "custom.spapart_or_product",
    "Vendor",
    "Image Src",
    "image preview",
    "All Images",
    "Image count"
  ];

  // แปลงเลขคอลัมน์ (1-based) เป็นตัวอักษรคอลัมน์ A1 เช่น 1 -> "A", 27 -> "AA"
  function columnToLetter(col) {
    let letter = "";
    while (col > 0) {
      const rem = (col - 1) % 26;
      letter = String.fromCharCode(65 + rem) + letter;
      col = Math.floor((col - 1) / 26);
    }
    return letter;
  }

  function writeRowsToSheet(sheetName, rows, finalHeaders) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) sheet = ss.insertSheet(sheetName);
    sheet.clear();

    const finalRows2D = [finalHeaders];
    rows.forEach(rowObj => {
      finalRows2D.push(finalHeaders.map(h => rowObj[h] != null ? rowObj[h] : ""));
    });

    const targetRows = finalRows2D.length;
    const currentMaxRows = sheet.getMaxRows();
    if (currentMaxRows < targetRows) {
      sheet.insertRowsAfter(currentMaxRows, targetRows - currentMaxRows);
    }
    sheet.getRange(1, 1, targetRows, finalHeaders.length).setValues(finalRows2D);
    sheet.setFrozenRows(1);

    // "image preview" = =IMAGE(<Image Src ในแถวเดียวกัน>, 4, 150, 150) ขนาดรูปคงที่ 150x150
    const PREVIEW_SIZE_PX = 150;
    const imageSrcCol = finalHeaders.indexOf("Image Src") + 1;
    const previewCol = finalHeaders.indexOf("image preview") + 1;
    if (imageSrcCol > 0 && previewCol > 0 && rows.length > 0) {
      const srcLetter = columnToLetter(imageSrcCol);
      const formulas = rows.map((_, i) => [`=IMAGE(${srcLetter}${i + 2}, 4, ${PREVIEW_SIZE_PX}, ${PREVIEW_SIZE_PX})`]);
      sheet.getRange(2, previewCol, rows.length, 1).setFormulas(formulas);
      sheet.setColumnWidth(previewCol, PREVIEW_SIZE_PX);
      sheet.setRowHeightsForced(2, rows.length, PREVIEW_SIZE_PX);
    }

    // "Image count" = นับจำนวนรูปจาก All Images (คั่นด้วย ,) ในแถวเดียวกัน
    const allImagesCol = finalHeaders.indexOf("All Images") + 1;
    const countCol = finalHeaders.indexOf("Image count") + 1;
    if (allImagesCol > 0 && countCol > 0 && rows.length > 0) {
      const allLetter = columnToLetter(allImagesCol);
      const formulas = rows.map((_, i) => {
        const cell = `${allLetter}${i + 2}`;
        return [`=IF(${cell}="",0,LEN(${cell})-LEN(SUBSTITUTE(${cell},",",""))+1)`];
      });
      sheet.getRange(2, countCol, rows.length, 1).setFormulas(formulas);
    }

    Logger.log("  ✅ เขียนชีท '" + sheetName + "' แล้ว " + rows.length + " แถว");
  }

  function logToSheet(statusMsg, productCount, sparepartCount, unmatchedCount) {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let logSheet = ss.getSheetByName(LOG_SHEET_NAME);

      if (!logSheet) {
        logSheet = ss.insertSheet(LOG_SHEET_NAME);
        logSheet.getRange(1, 1, 1, 5).setValues([["Timestamp", "Status", "Product Rows", "Sparepart Rows", "Unmatched Rows"]]);
        logSheet.getRange(1, 1, 1, 5).setFontWeight("bold");
        logSheet.setFrozenRows(1);
      }

      const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
      logSheet.appendRow([timestamp, statusMsg, productCount, sparepartCount, unmatchedCount]);
    } catch (logErr) {
      Logger.log("[WARN] ไม่สามารถบันทึก Log ลงชีทได้: " + logErr.message);
    }
  }

  // 3. MAIN TEST FLOW
  Logger.log("🧪 เริ่มทดสอบ: ดึงตัวอย่างหมวด '" + VALUE_PRODUCT + "' (" + LIMIT + " รายการ)...");
  const productNodes = fetchProductsByCategory(VALUE_PRODUCT, LIMIT);

  Logger.log("🧪 เริ่มทดสอบ: ดึงตัวอย่างหมวด '" + VALUE_SPAREPART_LIST.join(", ") + "' (" + LIMIT + " รายการ)...");
  const sparepartNodes = fetchProductsByCategory(VALUE_SPAREPART_LIST, LIMIT);

  const productRows = [];
  const sparepartRows = [];
  const unmatchedRows = [];

  productNodes.concat(sparepartNodes).forEach(node => {
    const rows = buildRows(node);
    const spVal = node.spVal ? node.spVal.value : "";

    if (spVal === VALUE_PRODUCT) {
      productRows.push(...rows);
    } else if (VALUE_SPAREPART_LIST.indexOf(spVal) !== -1) {
      sparepartRows.push(...rows);
    } else {
      // เงื่อนไขเผื่อ: ค่า custom.spapart_or_product ไม่ตรงกับที่คาดไว้ทั้งหมด (ว่าง/พิมพ์ผิด/ค่าอื่น)
      Logger.log("⚠️ พบสินค้าที่ custom.spapart_or_product ไม่ตรงเงื่อนไข (id: " + node.id + ", value: '" + spVal + "')");
      unmatchedRows.push(...rows);
    }
  });

  writeRowsToSheet(SHEET_PRODUCT, productRows, FULL_HEADERS);
  writeRowsToSheet(SHEET_SPAREPART, sparepartRows, SPAREPART_HEADERS);
  if (unmatchedRows.length > 0) {
    writeRowsToSheet("unmatched_test", unmatchedRows, FULL_HEADERS);
  }

  const summary = `✅ เทสเสร็จแล้ว | product: ${productRows.length} แถว | sparepart: ${sparepartRows.length} แถว | unmatched: ${unmatchedRows.length} แถว`;
  Logger.log(summary);
  logToSheet(summary, productRows.length, sparepartRows.length, unmatchedRows.length);
}

// ============================================================
// PRODUCTION MODE — ดึงสินค้าทั้งหมดจริงด้วย Bulk Operation API
// (เทสผ่านแล้วด้วย exportProductForCheckDataTest ก่อนหน้านี้)
// ============================================================
function exportProductForCheckData() {
  // 1. CONFIG & CONSTANTS
  const SHOP = PropertiesService.getScriptProperties().getProperty("SHOP") || "sevenfive-4062.myshopify.com";
  const CLIENT_ID = PropertiesService.getScriptProperties().getProperty("CLIENT_ID") || "696e1e9162c702cc07c2f94a1beacf8a";
  const CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("CLIENT_SECRET");

  const SHEET_PRODUCT = "product";
  const SHEET_SPAREPART = "sparepart";
  const LOG_SHEET_NAME = "Logrun script";
  const POLL_INTERVAL_MS = 10000;

  const PROP_ACCESS_TOKEN = "ACCESS_TOKEN";
  const PROP_TOKEN_EXPIRY = "TOKEN_EXPIRY";
  const PROP_LAST_BULK_OP_ID = "LAST_BULK_OP_ID_CHECK_DATA";

  const VALUE_PRODUCT = "สินค้า";
  const VALUE_SPAREPART_LIST = ["อะไหล่", "สินค้าสิ้นเปลือง"]; // 2 ค่าแยกกัน ไม่ใช่สตริงเดียว (อ้างอิง get_inventory_web_stock_new.js)

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
        status
        vendor
        descriptionHtml
        metafields(namespace: "custom") {
          edges {
            node { namespace key value }
          }
        }
        variants {
          edges {
            node { id sku }
          }
        }
        images {
          edges {
            node { id url }
          }
        }
        media {
          edges {
            node {
              mediaContentType
              ... on ExternalVideo { originUrl embedUrl }
              ... on Video { sources { url } }
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

  // โหลด JSONL แบบแบ่ง chunk ด้วย Range header (กันไฟล์ถูกตัดขาดกลางทางเมื่อไฟล์ใหญ่เกิน
  // ที่ UrlFetchApp.fetch() รวดเดียวจะรับไหว — อ้างอิงแพทเทิร์นเดียวกับ get_data_form_web_stock.js)
  function parseJSONL(url) {
    Logger.log("Downloading JSONL in chunks...");

    const products = {}, variants = {}, meta = {}, images = {}, videos = {};
    let startByte = 0;
    const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB ต่อ chunk
    let totalLinesParsed = 0;

    while (true) {
      const endByte = startByte + CHUNK_SIZE - 1;
      const res = UrlFetchApp.fetch(url, {
        headers: { "Range": `bytes=${startByte}-${endByte}` },
        muteHttpExceptions: true
      });

      const code = res.getResponseCode();
      if (code >= 400) {
        if (code === 416) break; // เกินขอบเขตไฟล์แล้ว = โหลดครบแล้ว
        Logger.log("[ERROR] Download chunk failed (HTTP " + code + ")");
        return null;
      }

      const bytes = res.getContent();
      if (!bytes || bytes.length === 0) break;

      let isDone = false;
      let validBytes = bytes;
      let nextStart = startByte + bytes.length;

      if (code === 206 && bytes.length === CHUNK_SIZE) {
        // ตัดตรงบรรทัดสุดท้ายที่สมบูรณ์ เผื่อ chunk ตัดกลางบรรทัด JSON
        const lastNewlineIndex = bytes.lastIndexOf(10);
        if (lastNewlineIndex !== -1) {
          validBytes = bytes.slice(0, lastNewlineIndex + 1);
          nextStart = startByte + lastNewlineIndex + 1;
        }
      } else {
        isDone = true; // ได้ chunk สั้นกว่าที่ขอ = ถึงท้ายไฟล์แล้ว
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
          } else if ((gid.indexOf("/ProductImage/") !== -1 || gid.indexOf("/MediaImage/") !== -1) && parent) {
            if (!images[parent]) images[parent] = [];
            if (obj.url) images[parent].push(obj.url);
          } else if (obj.namespace && obj.key && parent) {
            if (!meta[parent]) meta[parent] = {};
            meta[parent][`${obj.namespace}.${obj.key}`] = obj.value;
          } else if (parent && (obj.mediaContentType || gid.indexOf("/ExternalVideo/") !== -1 || gid.indexOf("/Video/") !== -1)) {
            let videoUrl = "";
            if (obj.originUrl) videoUrl = obj.originUrl;
            else if (obj.embedUrl) videoUrl = obj.embedUrl;
            else if (obj.sources && obj.sources.length > 0 && obj.sources[0].url) videoUrl = obj.sources[0].url;

            if (videoUrl) {
              if (!videos[parent]) videos[parent] = [];
              if (videos[parent].indexOf(videoUrl) === -1) videos[parent].push(videoUrl);
            }
          }
        } catch (e) {}
      });

      Logger.log(`  โหลดแล้ว ${totalLinesParsed} บรรทัด (ถึง byte ${nextStart})...`);

      if (isDone) break;
      startByte = nextStart;
    }

    Logger.log(`  ${totalLinesParsed} lines downloaded and parsed (chunked).`);
    return { products, variants, meta, images, videos };
  }

  function buildRowsFromParsed(pid, parsed) {
    const p = parsed.products[pid];
    const mf = parsed.meta[pid] || {};
    const pVariants = parsed.variants[pid] || [{}];
    const pImages = (parsed.images[pid] || []).filter(Boolean);
    const pVideos = parsed.videos[pid] || [];

    const spVal = mf["custom.spapart_or_product"] || "";

    let goodId = mf["custom.good_id"];
    if (goodId != null && goodId !== "") {
      const parsedNum = parseInt(goodId, 10);
      goodId = isNaN(parsedNum) ? "" : parsedNum;
    } else {
      goodId = "";
    }

    const userManual = mf["custom.user_manual"] || "";
    const datasheet = mf["custom.datasheet"] || "";
    const linkPdf = mf["custom.link_pdf"] || "";
    const bodyHtml = p.descriptionHtml || "";
    const status = p.status || "";
    const vendor = p.vendor || "";

    return {
      spVal: spVal,
      rows: pVariants.map(v => ({
        "custom.good_id": goodId,
        "Variant SKU": v.sku || "",
        "Body (HTML)": bodyHtml,
        "Status": status,
        "custom.spapart_or_product": spVal,
        "Vendor": vendor,
        "Image Src": pImages[0] || "",
        "All Images": pImages.join(", "),
        "media video": pVideos.join(", "),
        "User Manual": userManual,
        "Datasheet": datasheet,
        "LInk pdf": linkPdf
      }))
    };
  }

  const FULL_HEADERS = [
    "custom.good_id",
    "Variant SKU",
    "Body (HTML)",
    "Status",
    "custom.spapart_or_product",
    "Vendor",
    "Image Src",
    "image preview",
    "All Images",
    "Image count",
    "media video",
    "User Manual",
    "Datasheet",
    "LInk pdf"
  ];

  const SPAREPART_HEADERS = [
    "custom.good_id",
    "Variant SKU",
    "Status",
    "custom.spapart_or_product",
    "Vendor",
    "Image Src",
    "image preview",
    "All Images",
    "Image count"
  ];

  // แปลงเลขคอลัมน์ (1-based) เป็นตัวอักษรคอลัมน์ A1 เช่น 1 -> "A", 27 -> "AA"
  function columnToLetter(col) {
    let letter = "";
    while (col > 0) {
      const rem = (col - 1) % 26;
      letter = String.fromCharCode(65 + rem) + letter;
      col = Math.floor((col - 1) / 26);
    }
    return letter;
  }

  function writeRowsToSheet(sheetName, rows, finalHeaders) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ssId = ss.getId();
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      SpreadsheetApp.flush();
    }

    const finalRows2D = [finalHeaders];
    rows.forEach(rowObj => {
      finalRows2D.push(finalHeaders.map(h => rowObj[h] != null ? rowObj[h] : ""));
    });

    const targetRows = finalRows2D.length;
    const targetCols = finalHeaders.length;
    let usedSheetsApi = false;

    if (typeof Sheets !== "undefined") {
      try {
        Logger.log("  Writing '" + sheetName + "' with Sheets API...");
        const sheetId = sheet.getSheetId();
        Sheets.Spreadsheets.Values.clear({}, ssId, sheetName);

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
            `${sheetName}!A${startRow}`,
            { valueInputOption: "RAW" }
          );
        }
        usedSheetsApi = true;
        Logger.log(`  ✅ Done writing ${targetRows} rows to '${sheetName}' with Sheets API.`);
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

    // "image preview" = =IMAGE(<Image Src ในแถวเดียวกัน>, 4, 150, 150) ขนาดรูปคงที่ 150x150
    const PREVIEW_SIZE_PX = 150;
    const imageSrcCol = finalHeaders.indexOf("Image Src") + 1;
    const previewCol = finalHeaders.indexOf("image preview") + 1;
    if (imageSrcCol > 0 && previewCol > 0 && rows.length > 0) {
      const srcLetter = columnToLetter(imageSrcCol);
      const formulas = rows.map((_, i) => [`=IMAGE(${srcLetter}${i + 2}, 4, ${PREVIEW_SIZE_PX}, ${PREVIEW_SIZE_PX})`]);
      sheet.getRange(2, previewCol, rows.length, 1).setFormulas(formulas);
      sheet.setColumnWidth(previewCol, PREVIEW_SIZE_PX);
      sheet.setRowHeightsForced(2, rows.length, PREVIEW_SIZE_PX);
    }

    // "Image count" = นับจำนวนรูปจาก All Images (คั่นด้วย ,) ในแถวเดียวกัน
    const allImagesCol = finalHeaders.indexOf("All Images") + 1;
    const countCol = finalHeaders.indexOf("Image count") + 1;
    if (allImagesCol > 0 && countCol > 0 && rows.length > 0) {
      const allLetter = columnToLetter(allImagesCol);
      const formulas = rows.map((_, i) => {
        const cell = `${allLetter}${i + 2}`;
        return [`=IF(${cell}="",0,LEN(${cell})-LEN(SUBSTITUTE(${cell},",",""))+1)`];
      });
      sheet.getRange(2, countCol, rows.length, 1).setFormulas(formulas);
    }

    Logger.log("  ✅ เขียนชีท '" + sheetName + "' แล้ว " + rows.length + " แถว");
  }

  function logToSheet(statusMsg, productCount, sparepartCount, unmatchedCount) {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let logSheet = ss.getSheetByName(LOG_SHEET_NAME);

      if (!logSheet) {
        logSheet = ss.insertSheet(LOG_SHEET_NAME);
        logSheet.getRange(1, 1, 1, 5).setValues([["Timestamp", "Status", "Product Rows", "Sparepart Rows", "Unmatched Rows"]]);
        logSheet.getRange(1, 1, 1, 5).setFontWeight("bold");
        logSheet.setFrozenRows(1);
      }

      const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
      logSheet.appendRow([timestamp, statusMsg, productCount, sparepartCount, unmatchedCount]);
    } catch (logErr) {
      Logger.log("[WARN] ไม่สามารถบันทึก Log ลงชีทได้: " + logErr.message);
    }
  }

  // 3. MAIN PRODUCTION FLOW
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_LAST_BULK_OP_ID);

  Logger.log("🚀 เริ่มดึงสินค้าทั้งหมดจาก Shopify (Bulk Operation)...");

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

  Logger.log("✅ Bulk operation เสร็จสมบูรณ์ (" + result.objectCount + " objects) กำลังดาวน์โหลดและประมวลผล...");
  const parsed = parseJSONL(result.url);
  if (!parsed) {
    Logger.log("❌ ดาวน์โหลด/ประมวลผล JSONL ไม่สำเร็จ");
    return;
  }

  const productRows = [];
  const sparepartRows = [];
  const unmatchedRows = [];

  Object.keys(parsed.products).forEach(pid => {
    const built = buildRowsFromParsed(pid, parsed);

    if (built.spVal === VALUE_PRODUCT) {
      productRows.push(...built.rows);
    } else if (VALUE_SPAREPART_LIST.indexOf(built.spVal) !== -1) {
      sparepartRows.push(...built.rows);
    } else {
      Logger.log("⚠️ พบสินค้าที่ custom.spapart_or_product ไม่ตรงเงื่อนไข (id: " + pid + ", value: '" + built.spVal + "')");
      unmatchedRows.push(...built.rows);
    }
  });

  writeRowsToSheet(SHEET_PRODUCT, productRows, FULL_HEADERS);
  writeRowsToSheet(SHEET_SPAREPART, sparepartRows, SPAREPART_HEADERS);
  if (unmatchedRows.length > 0) {
    writeRowsToSheet("unmatched", unmatchedRows, FULL_HEADERS);
  }

  const summary = `✅ Export เสร็จสมบูรณ์ | product: ${productRows.length} แถว | sparepart: ${sparepartRows.length} แถว | unmatched: ${unmatchedRows.length} แถว`;
  Logger.log(summary);
  logToSheet(summary, productRows.length, sparepartRows.length, unmatchedRows.length);
}

// ============================================================
// DIAGNOSTIC — เทียบ SKU ระหว่างชีต "Products Export" (สคริปต์เก่า, มี query filter)
// กับชีต "product"/"sparepart" (สคริปต์ใหม่, export ทั้งหมดแล้วแยกทีหลัง)
// หา SKU ที่หายไป แล้วดึงค่า custom.spapart_or_product สดจาก Shopify มาเช็คสาเหตุ
// ============================================================
function diffProductsExportVsSplit(liveCheckSampleSize) {
  const SAMPLE_SIZE = liveCheckSampleSize || 50;

  const SHOP = PropertiesService.getScriptProperties().getProperty("SHOP") || "sevenfive-4062.myshopify.com";
  const CLIENT_ID = PropertiesService.getScriptProperties().getProperty("CLIENT_ID") || "696e1e9162c702cc07c2f94a1beacf8a";
  const CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("CLIENT_SECRET");

  const PROP_ACCESS_TOKEN = "ACCESS_TOKEN";
  const PROP_TOKEN_EXPIRY = "TOKEN_EXPIRY";

  function getAccessToken() {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty(PROP_ACCESS_TOKEN);
    const expiry = Number(props.getProperty(PROP_TOKEN_EXPIRY) || 0);
    if (token && Date.now() < expiry - 300000) return token;

    const res = UrlFetchApp.fetch("https://" + SHOP + "/admin/oauth/access_token", {
      method: "post",
      contentType: "application/x-www-form-urlencoded",
      payload: "grant_type=client_credentials&client_id=" + encodeURIComponent(CLIENT_ID) + "&client_secret=" + encodeURIComponent(CLIENT_SECRET),
      muteHttpExceptions: true
    });
    const data = JSON.parse(res.getContentText());
    if (!data.access_token) throw new Error("Token failed: " + res.getContentText());

    const newExpiry = Date.now() + ((Number(data.expires_in) || 3600) * 1000);
    props.setProperty(PROP_ACCESS_TOKEN, data.access_token);
    props.setProperty(PROP_TOKEN_EXPIRY, String(newExpiry));
    return data.access_token;
  }

  function callGraphQL(payload) {
    const accessToken = getAccessToken();
    const res = UrlFetchApp.fetch("https://" + SHOP + "/admin/api/2025-01/graphql.json", {
      method: "post",
      contentType: "application/json",
      headers: { "X-Shopify-Access-Token": accessToken },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 400) {
      Logger.log("[ERROR] GraphQL HTTP " + res.getResponseCode() + ": " + res.getContentText().substring(0, 300));
      return null;
    }
    return JSON.parse(res.getContentText());
  }

  // อ่านคอลัมน์ SKU จากชีตใดๆ โดยหาตำแหน่งคอลัมน์จาก header name แบบไดนามิก (กัน column order ไม่ตรงกัน)
  function readSkuSet(sheetName, headerName) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);
    const skuSet = new Set();
    if (!sheet) {
      Logger.log("⚠️ ไม่พบชีต '" + sheetName + "'");
      return skuSet;
    }
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 2) return skuSet;

    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
    const skuColIdx = headers.indexOf(headerName);
    if (skuColIdx === -1) {
      Logger.log("⚠️ ไม่พบคอลัมน์ '" + headerName + "' ในชีต '" + sheetName + "'");
      return skuSet;
    }

    const values = sheet.getRange(2, skuColIdx + 1, lastRow - 1, 1).getValues();
    values.forEach(row => {
      const sku = String(row[0] || "").trim();
      if (sku) skuSet.add(sku);
    });
    return skuSet;
  }

  // เช็คค่า custom.spapart_or_product สดจาก Shopify ทีละชุด (batch ด้วย GraphQL alias)
  function liveCheckSkus(skuList) {
    const results = {};
    const BATCH_SIZE = 20;

    for (let i = 0; i < skuList.length; i += BATCH_SIZE) {
      const batch = skuList.slice(i, i + BATCH_SIZE);
      const aliasQueries = batch.map((sku, idx) => `
        v${idx}: productVariants(first: 1, query: "sku:'${sku.replace(/'/g, "\\'")}'") {
          edges {
            node {
              sku
              product {
                id
                status
                spVal: metafield(namespace: "custom", key: "spapart_or_product") { value }
              }
            }
          }
        }
      `).join("\n");

      const resData = callGraphQL({ query: `{ ${aliasQueries} }` });
      if (!resData || !resData.data) continue;

      batch.forEach((sku, idx) => {
        const edges = resData.data["v" + idx] && resData.data["v" + idx].edges;
        if (edges && edges.length > 0) {
          const node = edges[0].node;
          results[sku] = {
            found: true,
            status: node.product.status,
            spVal: node.product.spVal ? node.product.spVal.value : "(ไม่มีค่า/metafield ว่าง)"
          };
        } else {
          results[sku] = { found: false, status: "", spVal: "" };
        }
      });

      Logger.log(`  เช็คสด ${Math.min(i + BATCH_SIZE, skuList.length)}/${skuList.length} SKU แล้ว`);
    }

    return results;
  }

  // 1. อ่าน SKU จากทั้ง 3 ชีต
  Logger.log("📖 อ่าน SKU จากชีต 'Products Export'...");
  const exportSkus = readSkuSet("Products Export", "Variant SKU");
  Logger.log("  พบ " + exportSkus.size + " SKU");

  Logger.log("📖 อ่าน SKU จากชีต 'product'...");
  const productSkus = readSkuSet("product", "Variant SKU");
  Logger.log("  พบ " + productSkus.size + " SKU");

  Logger.log("📖 อ่าน SKU จากชีต 'sparepart'...");
  const sparepartSkus = readSkuSet("sparepart", "Variant SKU");
  Logger.log("  พบ " + sparepartSkus.size + " SKU");

  // 2. หา SKU ที่อยู่ใน Products Export แต่ไม่อยู่ใน product (ของสคริปต์ใหม่)
  const missingFromProduct = [];
  exportSkus.forEach(sku => {
    if (!productSkus.has(sku)) missingFromProduct.push(sku);
  });

  const missingButInSparepart = missingFromProduct.filter(sku => sparepartSkus.has(sku));
  const missingEverywhere = missingFromProduct.filter(sku => !sparepartSkus.has(sku));

  Logger.log(`📊 สรุปเบื้องต้น: SKU ใน 'Products Export' ทั้งหมด ${exportSkus.size} | หายจาก 'product' ${missingFromProduct.length} รายการ`);
  Logger.log(`   ในจำนวนที่หาย: ไปโผล่ใน 'sparepart' แทน ${missingButInSparepart.length} | หายไปเลยทั้งสองชีต ${missingEverywhere.length}`);

  // 3. เช็คค่าจริงสดจาก Shopify สำหรับกลุ่ม "หายไปเลยทั้งสองชีต" (กลุ่มที่น่าสงสัยที่สุด) ตามจำนวน sample ที่กำหนด
  const sampleToCheck = missingEverywhere.slice(0, SAMPLE_SIZE);
  Logger.log(`🔎 เช็คค่าสดจาก Shopify สำหรับตัวอย่าง ${sampleToCheck.length} SKU (จากทั้งหมด ${missingEverywhere.length} ที่หายไปเลย)...`);
  const liveResults = liveCheckSkus(sampleToCheck);

  // 4. เขียนผลลงชีต diff_check
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let diffSheet = ss.getSheetByName("diff_check");
  if (!diffSheet) diffSheet = ss.insertSheet("diff_check");
  diffSheet.clear();

  const headers = ["SKU", "อยู่ใน sparepart?", "พบใน Shopify (สด)?", "Status (สด)", "custom.spapart_or_product (สด)"];
  const rows = [headers];

  missingFromProduct.forEach(sku => {
    const inSparepart = sparepartSkus.has(sku);
    const live = liveResults[sku];
    rows.push([
      sku,
      inSparepart ? "TRUE" : "FALSE",
      live ? (live.found ? "TRUE" : "FALSE") : "(ไม่ได้เช็ค - เกิน sample)",
      live ? live.status : "",
      live ? live.spVal : ""
    ]);
  });

  diffSheet.getRange(1, 1, rows.length, headers.length).setValues(rows);
  diffSheet.setFrozenRows(1);

  const summary = `เทียบเสร็จ | Products Export: ${exportSkus.size} SKU | หายจาก product: ${missingFromProduct.length} (ไปอยู่ sparepart: ${missingButInSparepart.length}, หายเลย: ${missingEverywhere.length}) | เช็คสดแล้ว: ${sampleToCheck.length} SKU`;
  Logger.log("✅ " + summary);
  Logger.log("ดูรายละเอียดที่ชีต 'diff_check'");
}

// ============================================================
// DIAGNOSTIC — นับจำนวนสินค้า/variant "ทั้งหมดไม่ filter" แบบเบาๆ อิสระจากไฟล์อื่น
// (ไม่เขียนลงชีต ไม่ดึง field ที่ไม่จำเป็น เอาไว้เทียบ ground-truth กับผลของ export_product_for_check_data
//  และกับตัวเลขที่ exportProductsToSheet() รายงาน โดยไม่ต้องพึ่งไฟล์ที่ชื่อฟังก์ชันชนกัน)
// ============================================================
function countAllProductsRaw() {
  const SHOP = PropertiesService.getScriptProperties().getProperty("SHOP") || "sevenfive-4062.myshopify.com";
  const CLIENT_ID = PropertiesService.getScriptProperties().getProperty("CLIENT_ID") || "696e1e9162c702cc07c2f94a1beacf8a";
  const CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("CLIENT_SECRET");
  const POLL_INTERVAL_MS = 10000;

  const PROP_ACCESS_TOKEN = "ACCESS_TOKEN";
  const PROP_TOKEN_EXPIRY = "TOKEN_EXPIRY";

  function getAccessToken() {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty(PROP_ACCESS_TOKEN);
    const expiry = Number(props.getProperty(PROP_TOKEN_EXPIRY) || 0);
    if (token && Date.now() < expiry - 300000) return token;

    const res = UrlFetchApp.fetch("https://" + SHOP + "/admin/oauth/access_token", {
      method: "post",
      contentType: "application/x-www-form-urlencoded",
      payload: "grant_type=client_credentials&client_id=" + encodeURIComponent(CLIENT_ID) + "&client_secret=" + encodeURIComponent(CLIENT_SECRET),
      muteHttpExceptions: true
    });
    const data = JSON.parse(res.getContentText());
    if (!data.access_token) throw new Error("Token failed: " + res.getContentText());

    const newExpiry = Date.now() + ((Number(data.expires_in) || 3600) * 1000);
    props.setProperty(PROP_ACCESS_TOKEN, data.access_token);
    props.setProperty(PROP_TOKEN_EXPIRY, String(newExpiry));
    return data.access_token;
  }

  function callGraphQL(payload) {
    const accessToken = getAccessToken();
    const res = UrlFetchApp.fetch("https://" + SHOP + "/admin/api/2025-01/graphql.json", {
      method: "post",
      contentType: "application/json",
      headers: { "X-Shopify-Access-Token": accessToken },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 400) {
      Logger.log("[ERROR] GraphQL HTTP " + res.getResponseCode() + ": " + res.getContentText().substring(0, 300));
      return null;
    }
    return JSON.parse(res.getContentText());
  }

  // Bulk query เบาที่สุด — เอาแค่ id/sku ไม่ดึง html, images, metafields ฯลฯ เพื่อความเร็วและอิสระจากไฟล์อื่น
  function startBulkQuery() {
    const INNER_QUERY = `
{
  products {
    edges {
      node {
        id
        status
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
    if (!resData || !resData.data || !resData.data.bulkOperationRunQuery) return null;
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

  // 1. เช็ค/เริ่ม bulk operation
  Logger.log("🚀 เริ่มนับจำนวนสินค้า/variant ทั้งหมด (ไม่ filter, minimal fields)...");
  const checkRes = callGraphQL({ query: `{ currentBulkOperation(type: QUERY) { id status url } }` });
  const currentOp = (checkRes && checkRes.data) ? checkRes.data.currentBulkOperation : null;

  let opId = null;
  if (currentOp && (currentOp.status === "RUNNING" || currentOp.status === "CREATED")) {
    Logger.log("⏳ พบ Bulk Operation ที่กำลังทำงานอยู่ (" + currentOp.id + ") — จะรอตัวนี้แทนการเริ่มใหม่...");
    opId = currentOp.id;
  } else {
    opId = startBulkQuery();
    if (!opId) {
      Logger.log("❌ ไม่สามารถเริ่ม bulk query ได้");
      return;
    }
  }

  const result = pollStatusLoop(opId, 300000);
  if (result.status !== "COMPLETED" || !result.url) {
    Logger.log("❌ Bulk operation ล้มเหลวหรือหมดเวลา: " + JSON.stringify(result));
    return;
  }

  // 2. ดาวน์โหลด JSONL แล้วนับเฉยๆ ไม่เขียนชีต
  const res = UrlFetchApp.fetch(result.url, { muteHttpExceptions: true });
  const lines = res.getContentText().split('\n');

  let productCount = 0;
  let variantCount = 0;
  let productsWithNoVariant = 0;
  const productHasVariant = {};

  lines.forEach(line => {
    if (!line.trim()) return;
    try {
      const obj = JSON.parse(line);
      const gid = obj.id || "";
      const parent = obj.__parentId || "";
      if (gid.indexOf("/Product/") !== -1 && !parent) {
        productCount++;
        productHasVariant[gid] = false;
      } else if (gid.indexOf("/ProductVariant/") !== -1 && parent) {
        variantCount++;
        productHasVariant[parent] = true;
      }
    } catch (e) {}
  });

  Object.keys(productHasVariant).forEach(pid => {
    if (!productHasVariant[pid]) productsWithNoVariant++;
  });

  Logger.log("============================================================");
  Logger.log(`✅ นับเสร็จ (ไม่ filter อะไรทั้งนั้น, live ตอนนี้):`);
  Logger.log(`   จำนวนสินค้า (Product): ${productCount}`);
  Logger.log(`   จำนวน variant รวม (นับเป็น "แถว" แบบเดียวกับที่ export_product_for_check_data ใช้): ${variantCount}`);
  Logger.log(`   สินค้าที่ไม่มี variant เลย (edge case): ${productsWithNoVariant}`);
  Logger.log("============================================================");
  Logger.log(`เทียบกับผลของ exportProductForCheckData() รอบล่าสุด: product 12,562 + sparepart 22,696 = 35,258 แถว`);
  Logger.log(`ถ้าตัวเลข variant รวมด้านบนใกล้เคียง 35,258 (หรือเท่ากันพอดี) แปลว่า export_product_for_check_data ไม่มีข้อมูลหายจริง`);
}

// ============================================================
// RESUMABLE PRODUCTION EXPORT (แก้ปัญหา Apps Script รันได้สูงสุด 6 นาที/ครั้ง)
// แยก "เริ่ม/รอ Bulk Operation" ออกจาก "ดาวน์โหลด+ประมวลผล+เขียนชีต" เป็นคนละ execution
// ผ่าน time-driven trigger แทนการ sleep-loop รอในรันเดียว
//
// วิธีใช้:
//   1. เรียก startExportProductCheckDataResumable() ครั้งเดียว (กด Run หรือผูก trigger เอง)
//   2. ระบบจะตั้ง trigger เช็คสถานะทุก 1 นาทีอัตโนมัติ จนกว่า Bulk Operation จะเสร็จ
//   3. พอเสร็จ จะดาวน์โหลด+เขียนชีต แล้วลบ trigger ตัวเองทิ้งอัตโนมัติ
//   ถ้าค้างผิดปกติ เรียก resetExportProductCheckDataResumable() เพื่อเคลียร์แล้วเริ่มใหม่
//
// หมายเหตุ: ต้องแยก helper เป็น top-level function (ไม่ห่อใน function เดียวแบบไฟล์อื่นในนี้)
// เพราะ trigger ของ Apps Script เรียกฟังก์ชัน top-level ตรงๆ ข้าม execution กัน closure
// ของ exportProductForCheckData() ใช้ข้ามรอบแบบนี้ไม่ได้ — ตั้ง prefix epcd_ ไว้กันชนกับไฟล์อื่น
// ============================================================

function epcd_ctx_() {
  const SHOP = PropertiesService.getScriptProperties().getProperty("SHOP") || "sevenfive-4062.myshopify.com";
  const CLIENT_ID = PropertiesService.getScriptProperties().getProperty("CLIENT_ID") || "696e1e9162c702cc07c2f94a1beacf8a";
  const CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("CLIENT_SECRET");

  const PROP_ACCESS_TOKEN = "ACCESS_TOKEN";
  const PROP_TOKEN_EXPIRY = "TOKEN_EXPIRY";

  function getAccessToken() {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty(PROP_ACCESS_TOKEN);
    const expiry = Number(props.getProperty(PROP_TOKEN_EXPIRY) || 0);
    if (token && Date.now() < expiry - 300000) return token;

    const res = UrlFetchApp.fetch("https://" + SHOP + "/admin/oauth/access_token", {
      method: "post",
      contentType: "application/x-www-form-urlencoded",
      payload: "grant_type=client_credentials&client_id=" + encodeURIComponent(CLIENT_ID) + "&client_secret=" + encodeURIComponent(CLIENT_SECRET),
      muteHttpExceptions: true
    });
    const data = JSON.parse(res.getContentText());
    if (!data.access_token) throw new Error("Token failed: " + res.getContentText());

    const newExpiry = Date.now() + ((Number(data.expires_in) || 3600) * 1000);
    props.setProperty(PROP_ACCESS_TOKEN, data.access_token);
    props.setProperty(PROP_TOKEN_EXPIRY, String(newExpiry));
    return data.access_token;
  }

  function callGraphQL(payload) {
    const accessToken = getAccessToken();
    const res = UrlFetchApp.fetch("https://" + SHOP + "/admin/api/2025-01/graphql.json", {
      method: "post",
      contentType: "application/json",
      headers: { "X-Shopify-Access-Token": accessToken },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 400) {
      Logger.log("[ERROR] GraphQL HTTP " + res.getResponseCode() + ": " + res.getContentText().substring(0, 300));
      return null;
    }
    return JSON.parse(res.getContentText());
  }

  function startBulkQuery() {
    const INNER_QUERY = `
{
  products {
    edges {
      node {
        id
        status
        vendor
        descriptionHtml
        metafields(namespace: "custom") {
          edges {
            node { namespace key value }
          }
        }
        variants {
          edges {
            node { id sku }
          }
        }
        images {
          edges {
            node { id url }
          }
        }
        media {
          edges {
            node {
              mediaContentType
              ... on ExternalVideo { originUrl embedUrl }
              ... on Video { sources { url } }
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
    const resData = callGraphQL({ query: BULK_MUTATION, variables: { query: INNER_QUERY } });
    if (!resData || !resData.data || !resData.data.bulkOperationRunQuery) return null;
    const runResult = resData.data.bulkOperationRunQuery;
    if (runResult.userErrors && runResult.userErrors.length > 0) {
      Logger.log("[ERROR] " + JSON.stringify(runResult.userErrors));
      return null;
    }
    return runResult.bulkOperation ? runResult.bulkOperation.id : null;
  }

  // เช็คสถานะครั้งเดียว (ไม่ sleep-loop) — ให้ trigger เป็นตัวเรียกซ้ำแทน
  function checkBulkOperationStatus(opId) {
    const query = `{ node(id: "${opId}") { ... on BulkOperation { id status url errorCode objectCount } } }`;
    const resData = callGraphQL({ query: query });
    return (resData && resData.data && resData.data.node) ? resData.data.node : null;
  }

  function parseJSONL(url) {
    Logger.log("Downloading JSONL in chunks...");
    const products = {}, variants = {}, meta = {}, images = {}, videos = {};
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
        return null;
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
            products[gid] = obj;
          } else if (gid.indexOf("/ProductVariant/") !== -1 && parent) {
            if (!variants[parent]) variants[parent] = [];
            variants[parent].push(obj);
          } else if ((gid.indexOf("/ProductImage/") !== -1 || gid.indexOf("/MediaImage/") !== -1) && parent) {
            if (!images[parent]) images[parent] = [];
            if (obj.url) images[parent].push(obj.url);
          } else if (obj.namespace && obj.key && parent) {
            if (!meta[parent]) meta[parent] = {};
            meta[parent][`${obj.namespace}.${obj.key}`] = obj.value;
          } else if (parent && (obj.mediaContentType || gid.indexOf("/ExternalVideo/") !== -1 || gid.indexOf("/Video/") !== -1)) {
            let videoUrl = "";
            if (obj.originUrl) videoUrl = obj.originUrl;
            else if (obj.embedUrl) videoUrl = obj.embedUrl;
            else if (obj.sources && obj.sources.length > 0 && obj.sources[0].url) videoUrl = obj.sources[0].url;
            if (videoUrl) {
              if (!videos[parent]) videos[parent] = [];
              if (videos[parent].indexOf(videoUrl) === -1) videos[parent].push(videoUrl);
            }
          }
        } catch (e) {}
      });

      Logger.log(`  โหลดแล้ว ${totalLinesParsed} บรรทัด (ถึง byte ${nextStart})...`);
      if (isDone) break;
      startByte = nextStart;
    }

    Logger.log(`  ${totalLinesParsed} lines downloaded and parsed (chunked).`);
    return { products, variants, meta, images, videos };
  }

  function buildRowsFromParsed(pid, parsed) {
    const p = parsed.products[pid];
    const mf = parsed.meta[pid] || {};
    const pVariants = parsed.variants[pid] || [{}];
    const pImages = (parsed.images[pid] || []).filter(Boolean);
    const pVideos = parsed.videos[pid] || [];
    const spVal = mf["custom.spapart_or_product"] || "";

    let goodId = mf["custom.good_id"];
    if (goodId != null && goodId !== "") {
      const parsedNum = parseInt(goodId, 10);
      goodId = isNaN(parsedNum) ? "" : parsedNum;
    } else {
      goodId = "";
    }

    const userManual = mf["custom.user_manual"] || "";
    const datasheet = mf["custom.datasheet"] || "";
    const linkPdf = mf["custom.link_pdf"] || "";
    const bodyHtml = p.descriptionHtml || "";
    const status = p.status || "";
    const vendor = p.vendor || "";

    return {
      spVal: spVal,
      rows: pVariants.map(v => ({
        "custom.good_id": goodId,
        "Variant SKU": v.sku || "",
        "Body (HTML)": bodyHtml,
        "Status": status,
        "custom.spapart_or_product": spVal,
        "Vendor": vendor,
        "Image Src": pImages[0] || "",
        "All Images": pImages.join(", "),
        "media video": pVideos.join(", "),
        "User Manual": userManual,
        "Datasheet": datasheet,
        "LInk pdf": linkPdf
      }))
    };
  }

  function columnToLetter(col) {
    let letter = "";
    while (col > 0) {
      const rem = (col - 1) % 26;
      letter = String.fromCharCode(65 + rem) + letter;
      col = Math.floor((col - 1) / 26);
    }
    return letter;
  }

  const FULL_HEADERS = [
    "custom.good_id", "Variant SKU", "Body (HTML)", "Status", "custom.spapart_or_product",
    "Vendor", "Image Src", "image preview", "All Images", "Image count",
    "media video", "User Manual", "Datasheet", "LInk pdf"
  ];
  const SPAREPART_HEADERS = [
    "custom.good_id", "Variant SKU", "Status", "custom.spapart_or_product",
    "Vendor", "Image Src", "image preview", "All Images", "Image count"
  ];

  function writeRowsToSheet(sheetName, rows, finalHeaders) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ssId = ss.getId();
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      SpreadsheetApp.flush();
    }

    const finalRows2D = [finalHeaders];
    rows.forEach(rowObj => {
      finalRows2D.push(finalHeaders.map(h => rowObj[h] != null ? rowObj[h] : ""));
    });

    const targetRows = finalRows2D.length;
    const targetCols = finalHeaders.length;
    let usedSheetsApi = false;

    if (typeof Sheets !== "undefined") {
      try {
        const sheetId = sheet.getSheetId();
        Sheets.Spreadsheets.Values.clear({}, ssId, sheetName);
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
            `${sheetName}!A${startRow}`,
            { valueInputOption: "RAW" }
          );
        }
        usedSheetsApi = true;
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

    const PREVIEW_SIZE_PX = 150;
    const imageSrcCol = finalHeaders.indexOf("Image Src") + 1;
    const previewCol = finalHeaders.indexOf("image preview") + 1;
    if (imageSrcCol > 0 && previewCol > 0 && rows.length > 0) {
      const srcLetter = columnToLetter(imageSrcCol);
      const formulas = rows.map((_, i) => [`=IMAGE(${srcLetter}${i + 2}, 4, ${PREVIEW_SIZE_PX}, ${PREVIEW_SIZE_PX})`]);
      sheet.getRange(2, previewCol, rows.length, 1).setFormulas(formulas);
      sheet.setColumnWidth(previewCol, PREVIEW_SIZE_PX);
      sheet.setRowHeightsForced(2, rows.length, PREVIEW_SIZE_PX);
    }

    const allImagesCol = finalHeaders.indexOf("All Images") + 1;
    const countCol = finalHeaders.indexOf("Image count") + 1;
    if (allImagesCol > 0 && countCol > 0 && rows.length > 0) {
      const allLetter = columnToLetter(allImagesCol);
      const formulas = rows.map((_, i) => {
        const cell = `${allLetter}${i + 2}`;
        return [`=IF(${cell}="",0,LEN(${cell})-LEN(SUBSTITUTE(${cell},",",""))+1)`];
      });
      sheet.getRange(2, countCol, rows.length, 1).setFormulas(formulas);
    }

    Logger.log("  ✅ เขียนชีท '" + sheetName + "' แล้ว " + rows.length + " แถว");
  }

  function logToSheet(statusMsg, productCount, sparepartCount, unmatchedCount) {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const LOG_SHEET_NAME = "Logrun script";
      let logSheet = ss.getSheetByName(LOG_SHEET_NAME);
      if (!logSheet) {
        logSheet = ss.insertSheet(LOG_SHEET_NAME);
        logSheet.getRange(1, 1, 1, 5).setValues([["Timestamp", "Status", "Product Rows", "Sparepart Rows", "Unmatched Rows"]]);
        logSheet.getRange(1, 1, 1, 5).setFontWeight("bold");
        logSheet.setFrozenRows(1);
      }
      const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
      logSheet.appendRow([timestamp, statusMsg, productCount, sparepartCount, unmatchedCount]);
    } catch (logErr) {
      Logger.log("[WARN] ไม่สามารถบันทึก Log ลงชีทได้: " + logErr.message);
    }
  }

  return {
    getAccessToken, callGraphQL, startBulkQuery, checkBulkOperationStatus,
    parseJSONL, buildRowsFromParsed, writeRowsToSheet, logToSheet,
    FULL_HEADERS, SPAREPART_HEADERS,
    VALUE_PRODUCT: "สินค้า",
    VALUE_SPAREPART_LIST: ["อะไหล่", "สินค้าสิ้นเปลือง"],
    SHEET_PRODUCT: "product",
    SHEET_SPAREPART: "sparepart"
  };
}

const EPCD_PROP_BULK_OP_ID = "EPCD_BULK_OP_ID";
const EPCD_PROP_IS_RUNNING = "EPCD_IS_RUNNING";
const EPCD_PROP_RUN_START = "EPCD_RUN_START";
const EPCD_TRIGGER_HANDLER_NAME = "checkAndContinueExportProductCheckData_";
const EPCD_MAX_WAIT_MS = 60 * 60 * 1000; // ยอมรอ Bulk Operation ได้สูงสุด 60 นาที ก่อนยอมแพ้แล้วเคลียร์สถานะ

function epcd_createTrigger_() {
  epcd_deleteTrigger_(); // กันซ้อน ถ้ามี trigger ค้างอยู่ก่อน
  ScriptApp.newTrigger(EPCD_TRIGGER_HANDLER_NAME)
    .timeBased()
    .everyMinutes(1)
    .create();
}

function epcd_deleteTrigger_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === EPCD_TRIGGER_HANDLER_NAME) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/**
 * เรียกฟังก์ชันนี้เพื่อ "เริ่ม" export แบบ resumable (ไม่บล็อครอ ไม่ชน 6 นาที)
 * จะตั้ง time-driven trigger ให้เช็คสถานะทุก 1 นาทีอัตโนมัติจนกว่าจะเสร็จ
 */
function startExportProductCheckDataResumable() {
  const props = PropertiesService.getScriptProperties();

  if (props.getProperty(EPCD_PROP_IS_RUNNING) === "true") {
    Logger.log("⚠️ มีการ export ทำงานอยู่แล้ว (เริ่มไว้ตั้งแต่ " + new Date(Number(props.getProperty(EPCD_PROP_RUN_START))).toISOString() + ") — ไม่เริ่มซ้ำ");
    Logger.log("   ถ้าค้างผิดปกติ ให้เรียก resetExportProductCheckDataResumable() ก่อนแล้วค่อยเริ่มใหม่");
    return;
  }

  const ctx = epcd_ctx_();

  Logger.log("🚀 เริ่ม export แบบ resumable (trigger-based)...");
  const checkRes = ctx.callGraphQL({ query: `{ currentBulkOperation(type: QUERY) { id status url objectCount } }` });
  const currentOp = (checkRes && checkRes.data) ? checkRes.data.currentBulkOperation : null;

  let opId = null;
  if (currentOp && (currentOp.status === "RUNNING" || currentOp.status === "CREATED")) {
    Logger.log("⏳ พบ Bulk Operation ที่กำลังทำงานอยู่ (" + currentOp.id + ") — จะรอตัวนี้แทนการเริ่มใหม่...");
    opId = currentOp.id;
  } else {
    opId = ctx.startBulkQuery();
    if (!opId) {
      Logger.log("❌ ไม่สามารถเริ่ม bulk query ได้ โปรดตรวจสอบ Log");
      return;
    }
    Logger.log("✅ เริ่ม Bulk Operation ใหม่สำเร็จ ID: " + opId);
  }

  props.setProperty(EPCD_PROP_BULK_OP_ID, opId);
  props.setProperty(EPCD_PROP_IS_RUNNING, "true");
  props.setProperty(EPCD_PROP_RUN_START, String(Date.now()));

  epcd_createTrigger_();
  Logger.log("⏰ ตั้ง trigger เช็คสถานะทุก 1 นาทีแล้ว — ระบบจะประมวลผลต่อเองอัตโนมัติเมื่อ Shopify ทำเสร็จ ปิดหน้านี้ได้เลย");
}

/**
 * Trigger handler — Apps Script เรียกเองทุก 1 นาทีอัตโนมัติ (อย่าเรียกตรงๆ ยกเว้นเทส)
 * เช็คสถานะครั้งเดียวแล้วออกทันทีถ้ายังไม่เสร็จ (ไม่ sleep-loop ค้าง) — ให้ trigger รอบหน้ามาเช็คต่อ
 * จนกว่าจะ COMPLETED ถึงจะดาวน์โหลด+เขียนชีตจริง (ส่วนที่หนักที่สุดเกิดขึ้นแค่ครั้งเดียวตอนจบ)
 */
function checkAndContinueExportProductCheckData_() {
  const props = PropertiesService.getScriptProperties();
  const opId = props.getProperty(EPCD_PROP_BULK_OP_ID);

  if (!opId) {
    Logger.log("⚠️ ไม่พบ Bulk Operation ID ที่บันทึกไว้ — ลบ trigger ทิ้ง");
    epcd_deleteTrigger_();
    props.deleteProperty(EPCD_PROP_IS_RUNNING);
    return;
  }

  const runStart = Number(props.getProperty(EPCD_PROP_RUN_START) || 0);
  if (runStart && (Date.now() - runStart) > EPCD_MAX_WAIT_MS) {
    Logger.log("❌ รอ Bulk Operation เกิน " + (EPCD_MAX_WAIT_MS / 60000) + " นาทีแล้ว ยอมแพ้และเคลียร์สถานะ (เรียก startExportProductCheckDataResumable() ใหม่เพื่อลองอีกครั้ง)");
    epcd_deleteTrigger_();
    props.deleteProperty(EPCD_PROP_BULK_OP_ID);
    props.deleteProperty(EPCD_PROP_IS_RUNNING);
    props.deleteProperty(EPCD_PROP_RUN_START);
    return;
  }

  const ctx = epcd_ctx_();
  const op = ctx.checkBulkOperationStatus(opId);

  if (!op) {
    Logger.log("❌ ไม่พบ Bulk Operation (" + opId + ") — เคลียร์สถานะ");
    epcd_deleteTrigger_();
    props.deleteProperty(EPCD_PROP_BULK_OP_ID);
    props.deleteProperty(EPCD_PROP_IS_RUNNING);
    props.deleteProperty(EPCD_PROP_RUN_START);
    return;
  }

  Logger.log(`⏳ [${op.status}] ${op.objectCount || 0} objects...`);

  if (op.status === "RUNNING" || op.status === "CREATED") {
    return; // ยังไม่เสร็จ ออกเลย รอ trigger รอบหน้า (1 นาทีถัดไป) มาเช็คต่อ
  }

  // เสร็จแล้วไม่ว่าจะสำเร็จหรือล้มเหลว — ลบ trigger ทันทีกันเรียกซ้ำระหว่างกำลังประมวลผล
  epcd_deleteTrigger_();

  if (op.status !== "COMPLETED" || !op.url) {
    Logger.log("❌ Bulk operation ล้มเหลว: " + JSON.stringify(op));
    props.deleteProperty(EPCD_PROP_BULK_OP_ID);
    props.deleteProperty(EPCD_PROP_IS_RUNNING);
    props.deleteProperty(EPCD_PROP_RUN_START);
    return;
  }

  Logger.log("✅ Bulk operation เสร็จสมบูรณ์ (" + op.objectCount + " objects) กำลังดาวน์โหลดและประมวลผล...");
  const parsed = ctx.parseJSONL(op.url);
  if (!parsed) {
    Logger.log("❌ ดาวน์โหลด/ประมวลผล JSONL ไม่สำเร็จ");
    props.deleteProperty(EPCD_PROP_BULK_OP_ID);
    props.deleteProperty(EPCD_PROP_IS_RUNNING);
    props.deleteProperty(EPCD_PROP_RUN_START);
    return;
  }

  const productRows = [];
  const sparepartRows = [];
  const unmatchedRows = [];

  Object.keys(parsed.products).forEach(pid => {
    const built = ctx.buildRowsFromParsed(pid, parsed);
    if (built.spVal === ctx.VALUE_PRODUCT) {
      productRows.push(...built.rows);
    } else if (ctx.VALUE_SPAREPART_LIST.indexOf(built.spVal) !== -1) {
      sparepartRows.push(...built.rows);
    } else {
      Logger.log("⚠️ พบสินค้าที่ custom.spapart_or_product ไม่ตรงเงื่อนไข (id: " + pid + ", value: '" + built.spVal + "')");
      unmatchedRows.push(...built.rows);
    }
  });

  ctx.writeRowsToSheet(ctx.SHEET_PRODUCT, productRows, ctx.FULL_HEADERS);
  ctx.writeRowsToSheet(ctx.SHEET_SPAREPART, sparepartRows, ctx.SPAREPART_HEADERS);
  if (unmatchedRows.length > 0) {
    ctx.writeRowsToSheet("unmatched", unmatchedRows, ctx.FULL_HEADERS);
  }

  const summary = `✅ Export เสร็จสมบูรณ์ (resumable) | product: ${productRows.length} แถว | sparepart: ${sparepartRows.length} แถว | unmatched: ${unmatchedRows.length} แถว`;
  Logger.log(summary);
  ctx.logToSheet(summary, productRows.length, sparepartRows.length, unmatchedRows.length);

  props.deleteProperty(EPCD_PROP_BULK_OP_ID);
  props.deleteProperty(EPCD_PROP_IS_RUNNING);
  props.deleteProperty(EPCD_PROP_RUN_START);
}

/**
 * เคลียร์สถานะค้าง (ใช้เมื่อ resumable export ค้างผิดปกติ แล้วอยากเริ่มใหม่)
 */
function resetExportProductCheckDataResumable() {
  epcd_deleteTrigger_();
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(EPCD_PROP_BULK_OP_ID);
  props.deleteProperty(EPCD_PROP_IS_RUNNING);
  props.deleteProperty(EPCD_PROP_RUN_START);
  Logger.log("✅ เคลียร์สถานะ resumable export แล้ว พร้อมเริ่มใหม่ด้วย startExportProductCheckDataResumable()");
}

/**
 * เช็คสถานะ resumable export รวดเดียว — กด Run ครั้งเดียวเห็นครบ
 * (แทนการไปไล่เปิด "การดำเนินการ" + "ทริกเกอร์" แยกกันหลาย panel)
 */
function checkExportProductCheckDataStatus() {
  const props = PropertiesService.getScriptProperties();
  const opId = props.getProperty(EPCD_PROP_BULK_OP_ID);
  const isRunning = props.getProperty(EPCD_PROP_IS_RUNNING) === "true";
  const runStart = Number(props.getProperty(EPCD_PROP_RUN_START) || 0);

  Logger.log("============================================================");
  Logger.log("📊 สถานะ Resumable Export");
  Logger.log("============================================================");
  Logger.log("IS_RUNNING (ค้างใน PropertiesService): " + isRunning);
  Logger.log("Bulk Operation ID ที่บันทึกไว้: " + (opId || "(ไม่มี)"));

  if (runStart) {
    const elapsedMs = Date.now() - runStart;
    const elapsedMin = Math.floor(elapsedMs / 60000);
    const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);
    Logger.log(`เริ่มไว้ตั้งแต่: ${new Date(runStart).toISOString()} (ผ่านมาแล้ว ${elapsedMin} นาที ${elapsedSec} วินาที)`);
    if (elapsedMs > EPCD_MAX_WAIT_MS) {
      Logger.log("⚠️ เกิน MAX_WAIT (" + (EPCD_MAX_WAIT_MS / 60000) + " นาที) แล้ว — trigger รอบหน้าจะยอมแพ้และเคลียร์สถานะเอง");
    }
  } else {
    Logger.log("ไม่มีเวลาเริ่มบันทึกไว้");
  }

  // เช็ค trigger ที่ยังตั้งอยู่จริง
  const triggers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === EPCD_TRIGGER_HANDLER_NAME);
  Logger.log("จำนวน trigger ที่ยังตั้งอยู่: " + triggers.length + (triggers.length > 0 ? " (ปกติ กำลังรอรอบถัดไป)" : " ⚠️ ไม่มี trigger เลย"));

  if (!opId) {
    Logger.log("============================================================");
    Logger.log("ไม่มี Bulk Operation ID ให้เช็ค — export ยังไม่ได้เริ่ม หรือเคลียร์สถานะไปแล้ว");
    Logger.log("============================================================");
    return;
  }

  // เช็คสถานะ Bulk Operation สดจาก Shopify ตรงๆ (ไม่ต้องรอ trigger รอบหน้า)
  const ctx = epcd_ctx_();
  const op = ctx.checkBulkOperationStatus(opId);

  Logger.log("------------------------------------------------------------");
  if (!op) {
    Logger.log("❌ ไม่พบ Bulk Operation นี้บน Shopify แล้ว (อาจถูกยกเลิก/หมดอายุ) — แนะนำเรียก resetExportProductCheckDataResumable() แล้วเริ่มใหม่");
  } else {
    Logger.log(`สถานะ Bulk Operation บน Shopify ตอนนี้: [${op.status}]`);
    Logger.log(`จำนวน objects ที่ประมวลผลไปแล้ว: ${op.objectCount || 0}`);
    if (op.status === "COMPLETED") {
      Logger.log("✅ เสร็จแล้วฝั่ง Shopify! รอ trigger รอบถัดไป (ภายใน 1 นาที) มาดาวน์โหลด+เขียนชีตให้อัตโนมัติ");
      Logger.log("   ถ้าไม่อยากรอ trigger เรียก checkAndContinueExportProductCheckData_() ตรงๆ ได้เลยตอนนี้เพื่อให้ดาวน์โหลด+เขียนชีตทันที");
    } else if (op.status === "RUNNING" || op.status === "CREATED") {
      Logger.log("⏳ Shopify ยังประมวลผลไม่เสร็จ — รอต่อไป ไม่มีอะไรผิดปกติ");
    } else {
      Logger.log("❌ สถานะผิดปกติ (" + op.status + ", errorCode: " + (op.errorCode || "-") + ") — แนะนำเรียก resetExportProductCheckDataResumable() แล้วเริ่มใหม่");
    }
  }
  Logger.log("============================================================");
}
