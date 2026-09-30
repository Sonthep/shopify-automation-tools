// ============================================================
// SHOPIFY BULK PRICE UPDATE
// Google Apps Script
//
// เงื่อนไข:
// - update_with_discount อ่าน A:J (10 คอลัมน์)
//   - D = Price (Special price), C = Compare At Price
//   - อัปเดตเมื่อ check Compare-at price update หรือ check price update = FALSE
// - update_no_discount อ่าน A:G (7 คอลัมน์)
//   - C = ราคาสินค้า (Price)
//   - อัปเดตเมื่อ check price update = FALSE
// - ไม่เขียน Log ลงชีต
// ============================================================


// ============================================================
// CONFIG
// ============================================================

var SHOPIFY_PRICE_CONFIG = {
  SHOP: "sevenfive-4062.myshopify.com",
  CLIENT_ID: "696e1e9162c702cc07c2f94a1beacf8a",
  CLIENT_SECRET: "YOUR_CLIENT_SECRET",

  SPREADSHEET_ID:
    "1FPEsVsZbIPmwEFOgnPJ8W9t7yKIS4NX5lY83gqskhcQ",

  SHEET_WITH_DISCOUNT: "update_with_discount",
  SHEET_NO_DISCOUNT: "update_no_discount",

  API_VERSION: "2026-07",

  PROP_ACCESS_TOKEN: "SHOPIFY_PRICE_ACCESS_TOKEN",
  PROP_TOKEN_EXPIRY: "SHOPIFY_PRICE_TOKEN_EXPIRY",
  PROP_BULK_OPERATION_ID: "SHOPIFY_PRICE_BULK_OPERATION_ID"
};


// ============================================================
// MAIN FUNCTION
// ============================================================

function updateAllPricesBulkMutation() {
  var startedAt = Date.now();

  console.log("================================================");
  console.log("🚀 เริ่มต้นอัปเดตราคา Shopify");
  console.log("================================================");

  try {
    var spreadsheet = openPriceSpreadsheet_();

    var jsonlLines = [];

    var totalWithDiscount = 0;
    var totalNoDiscount = 0;

    var skippedUpdateTrue = 0;
    var skippedInvalidGid = 0;
    var skippedInvalidPrice = 0;


    // ========================================================
    // 1. อ่าน update_with_discount
    // ช่วงข้อมูล A:J (10 คอลัมน์)
    // ========================================================

    console.time("อ่าน update_with_discount");

    var sheetWith = spreadsheet.getSheetByName(
      SHOPIFY_PRICE_CONFIG.SHEET_WITH_DISCOUNT
    );

    if (!sheetWith) {
      console.warn(
        "⚠️ ไม่พบชีต " +
        SHOPIFY_PRICE_CONFIG.SHEET_WITH_DISCOUNT
      );
    } else {
      var lastRowWith = sheetWith.getLastRow();

      if (lastRowWith >= 2) {
        /*
         * อ่านครอบคลุม A:J (10 คอลัมน์)
         *
         * Col A (0): GoodCode
         * Col B (1): (Unused/Compare-at price)
         * Col C (2): Compare At Price
         * Col D (3): Price (Discounted / Special price)
         * Col E (4): Compare At Price (website)
         * Col F (5): Price (website)
         * Col G (6): check Compare-at price update
         * Col H (7): check price update
         * Col I (8): Product GID
         * Col J (9): Variant GID
         */
        var dataWith = sheetWith
          .getRange(1, 1, lastRowWith, 10)
          .getValues();

        var headersWith = dataWith[0].map(function (header) {
          return String(header || "").trim();
        });

        var rowsWith = dataWith.slice(1);

        var comparePriceIndex = findColumnIndex_(
          headersWith,
          [
            "Compare At Price",
            "Compare-at price",
            "CompareAtPrice",
            "compare_at_price"
          ],
          2
        );

        var specialPriceIndex = findColumnIndex_(
          headersWith,
          [
            "Price",
            "special_price",
            "special price",
            "Price Web",
            "price",
            "ราคาพิเศษ"
          ],
          3
        );

        var checkCompareUpdateIndex = findColumnIndex_(
          headersWith,
          [
            "check Compare-at price update",
            "check Compare at price update",
            "check_compare_at_price_update",
            "check compare-at price update"
          ],
          6
        );

        var checkPriceUpdateIndex = findColumnIndex_(
          headersWith,
          [
            "check price update",
            "check_price_update"
          ],
          7
        );

        var productGidIndex = findColumnIndex_(
          headersWith,
          [
            "Product GID",
            "ProductGID",
            "product_gid"
          ],
          8
        );

        var variantGidIndex = findColumnIndex_(
          headersWith,
          [
            "Variant GID",
            "VariantGID",
            "variant_gid"
          ],
          9
        );

        console.log(
          "📥 update_with_discount มีข้อมูล " +
          rowsWith.length +
          " แถว"
        );

        for (var i = 0; i < rowsWith.length; i++) {
          var row = rowsWith[i];

          /*
           * เช็กเงื่อนไข: อัปเดตเมื่อ check Compare-at price update = FALSE หรือ check price update = FALSE
           */
          var isCompareFalse = (checkCompareUpdateIndex !== -1) && isUpdateFalse_(row[checkCompareUpdateIndex]);
          var isPriceFalse = (checkPriceUpdateIndex !== -1) && isUpdateFalse_(row[checkPriceUpdateIndex]);

          if (!isCompareFalse && !isPriceFalse) {
            skippedUpdateTrue++;
            continue;
          }

          var productGid = String(
            row[productGidIndex] || ""
          ).trim();

          var variantGid = String(
            row[variantGidIndex] || ""
          ).trim();

          if (
            !isValidProductGid_(productGid) ||
            !isValidVariantGid_(variantGid)
          ) {
            skippedInvalidGid++;
            continue;
          }

          // Column D (index 3): Price (นำไปเป็น price ใน Shopify)
          var specialPriceVal = parsePrice_(
            row[specialPriceIndex]
          );

          // Column C (index 2): Compare At Price (นำไปเป็น compareAtPrice ใน Shopify)
          var compareAtPriceVal = parsePrice_(
            row[comparePriceIndex]
          );

          if (
            specialPriceVal === null ||
            specialPriceVal < 0
          ) {
            skippedInvalidPrice++;
            continue;
          }

          var variantInput = {
            id: variantGid,
            price: specialPriceVal.toFixed(2),
            compareAtPrice:
              compareAtPriceVal !== null &&
              compareAtPriceVal > 0
                ? compareAtPriceVal.toFixed(2)
                : null
          };

          jsonlLines.push(
            JSON.stringify({
              productId: productGid,
              variants: [variantInput]
            })
          );

          totalWithDiscount++;
        }
      } else {
        console.log(
          "ℹ️ update_with_discount ไม่มีข้อมูล"
        );
      }
    }

    console.timeEnd("อ่าน update_with_discount");

    console.log(
      "✅ update_with_discount พร้อมอัปเดต " +
      totalWithDiscount +
      " รายการ"
    );


    // ========================================================
    // 2. อ่าน update_no_discount
    // ช่วงข้อมูล A:G (7 คอลัมน์)
    // ========================================================

    console.time("อ่าน update_no_discount");

    var sheetNo = spreadsheet.getSheetByName(
      SHOPIFY_PRICE_CONFIG.SHEET_NO_DISCOUNT
    );

    if (!sheetNo) {
      console.warn(
        "⚠️ ไม่พบชีต " +
        SHOPIFY_PRICE_CONFIG.SHEET_NO_DISCOUNT
      );
    } else {
      var lastRowNo = sheetNo.getLastRow();

      if (lastRowNo >= 2) {
        /*
         * อ่านครอบคลุม A:G (7 คอลัมน์)
         *
         * Col A (0): GoodID
         * Col B (1): GoodCode
         * Col C (2): ราคาสินค้า
         * Col D (3): price website
         * Col E (4): check price update
         * Col F (5): Product GID
         * Col G (6): Variant GID
         */
        var dataNo = sheetNo
          .getRange(1, 1, lastRowNo, 7)
          .getValues();

        var headersNo = dataNo[0].map(function (header) {
          return String(header || "").trim();
        });

        var rowsNo = dataNo.slice(1);

        var noPriceIndex = findColumnIndex_(
          headersNo,
          [
            "ราคาสินค้า",
            "ราคา",
            "Price",
            "price",
            "Price Web"
          ],
          2
        );

        var noCheckPriceUpdateIndex = findColumnIndex_(
          headersNo,
          [
            "check price update",
            "check_price_update",
            "check update",
            "Update",
            "update"
          ],
          4
        );

        var noProductGidIndex = findColumnIndex_(
          headersNo,
          [
            "Product GID",
            "ProductGID",
            "product_gid"
          ],
          5
        );

        var noVariantGidIndex = findColumnIndex_(
          headersNo,
          [
            "Variant GID",
            "VariantGID",
            "variant_gid"
          ],
          6
        );

        console.log(
          "📥 update_no_discount มีข้อมูล " +
          rowsNo.length +
          " แถว"
        );

        for (var j = 0; j < rowsNo.length; j++) {
          var noRow = rowsNo[j];

          /*
           * เช็กเงื่อนไข: อัปเดตเมื่อ check price update = FALSE
           */
          if (!isUpdateFalse_(noRow[noCheckPriceUpdateIndex])) {
            skippedUpdateTrue++;
            continue;
          }

          var noProductGid = String(
            noRow[noProductGidIndex] || ""
          ).trim();

          var noVariantGid = String(
            noRow[noVariantGidIndex] || ""
          ).trim();

          if (
            !isValidProductGid_(noProductGid) ||
            !isValidVariantGid_(noVariantGid)
          ) {
            skippedInvalidGid++;
            continue;
          }

          // Column C: ราคาสินค้า (นำไปเป็น price ใน Shopify)
          var noPriceVal = parsePrice_(
            noRow[noPriceIndex]
          );

          if (
            noPriceVal === null ||
            noPriceVal < 0
          ) {
            skippedInvalidPrice++;
            continue;
          }

          jsonlLines.push(
            JSON.stringify({
              productId: noProductGid,
              variants: [
                {
                  id: noVariantGid,
                  price: noPriceVal.toFixed(2),

                  /*
                   * ไม่มีส่วนลด
                   * ล้าง Compare-at price ใน Shopify
                   */
                  compareAtPrice: null
                }
              ]
            })
          );

          totalNoDiscount++;
        }
      } else {
        console.log(
          "ℹ️ update_no_discount ไม่มีข้อมูล"
        );
      }
    }

    console.timeEnd("อ่าน update_no_discount");

    console.log(
      "✅ update_no_discount พร้อมอัปเดต " +
      totalNoDiscount +
      " รายการ"
    );


    // ========================================================
    // 3. สรุปข้อมูล
    // ========================================================

    var totalItems = jsonlLines.length;

    console.log("------------------------------------------------");
    console.log("📊 สรุปข้อมูล");
    console.log(
      "มีส่วนลด              : " +
      totalWithDiscount
    );
    console.log(
      "ไม่มีส่วนลด            : " +
      totalNoDiscount
    );
    console.log(
      "ข้าม Update ไม่ใช่ FALSE: " +
      skippedUpdateTrue
    );
    console.log(
      "ข้าม GID ไม่ถูกต้อง     : " +
      skippedInvalidGid
    );
    console.log(
      "ข้ามราคาไม่ถูกต้อง      : " +
      skippedInvalidPrice
    );
    console.log(
      "รวมพร้อมส่ง Shopify     : " +
      totalItems
    );
    console.log("------------------------------------------------");

    if (totalItems === 0) {
      console.warn(
        "⚠️ ไม่พบข้อมูลที่ Update = FALSE และพร้อมอัปเดต"
      );

      return;
    }


    // ========================================================
    // 4. สร้าง JSONL
    // ========================================================

    var jsonlContent =
      jsonlLines.join("\n") + "\n";

    var jsonlBlob = Utilities.newBlob(
      jsonlContent,
      "text/jsonl",
      "price_bulk.jsonl"
    );

    var fileSizeBytes =
      jsonlBlob.getBytes().length;

    var fileSizeKb =
      Math.ceil(fileSizeBytes / 1024);

    var fileSizeMb =
      fileSizeBytes / 1024 / 1024;

    console.log(
      "📄 JSONL ขนาด " +
      fileSizeKb +
      " KB"
    );

    /*
     * Shopify Bulk JSONL จำกัด 100 MB
     */
    if (fileSizeMb > 100) {
      throw new Error(
        "ไฟล์ JSONL เกิน 100 MB: " +
        fileSizeMb.toFixed(2) +
        " MB"
      );
    }


    // ========================================================
    // 5. ขอ Staged Upload Target
    // ========================================================

    console.log(
      "⏳ ขั้นตอน 1/3: ขอ Staged Upload Target"
    );

    console.time("stagedUploadsCreate");

    var stageMutation = `
      mutation {
        stagedUploadsCreate(
          input: [
            {
              resource: BULK_MUTATION_VARIABLES
              filename: "price_bulk.jsonl"
              mimeType: "text/jsonl"
              httpMethod: POST
            }
          ]
        ) {
          stagedTargets {
            url
            resourceUrl
            parameters {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    var stageResponse = callShopifyGraphQL_(
      stageMutation,
      {}
    );

    console.timeEnd("stagedUploadsCreate");

    var stageResult =
      stageResponse &&
      stageResponse.data &&
      stageResponse.data.stagedUploadsCreate;

    if (!stageResult) {
      throw new Error(
        "Shopify ไม่ส่ง stagedUploadsCreate กลับมา"
      );
    }

    if (
      stageResult.userErrors &&
      stageResult.userErrors.length > 0
    ) {
      throw new Error(
        "stagedUploadsCreate Error: " +
        JSON.stringify(stageResult.userErrors)
      );
    }

    if (
      !stageResult.stagedTargets ||
      stageResult.stagedTargets.length === 0
    ) {
      throw new Error(
        "Shopify ไม่ส่ง Staged Upload Target กลับมา"
      );
    }

    var stagedTarget =
      stageResult.stagedTargets[0];

    console.log(
      "✅ ได้ Staged Upload Target"
    );


    // ========================================================
    // 6. Upload JSONL
    // ========================================================

    console.log(
      "⏳ ขั้นตอน 2/3: Upload JSONL"
    );

    console.time("upload JSONL");

    var uploadResult = uploadJsonlToShopify_(
      stagedTarget,
      jsonlBlob
    );

    console.timeEnd("upload JSONL");

    console.log(
      "✅ Upload JSONL สำเร็จ HTTP " +
      uploadResult.status
    );


    // ========================================================
    // 7. เริ่ม Bulk Operation
    // ========================================================

    console.log(
      "⏳ ขั้นตอน 3/3: เริ่ม Bulk Operation"
    );

    console.time("bulkOperationRunMutation");

    var bulkMutationString = `
      mutation variantPriceUpdate(
        $productId: ID!
        $variants: [ProductVariantsBulkInput!]!
      ) {
        productVariantsBulkUpdate(
          productId: $productId
          variants: $variants
        ) {
          productVariants {
            id
            price
            compareAtPrice
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    var runMutation = `
      mutation bulkRun(
        $mutation: String!
        $stagedUploadPath: String!
      ) {
        bulkOperationRunMutation(
          mutation: $mutation
          stagedUploadPath: $stagedUploadPath
        ) {
          bulkOperation {
            id
            status
            createdAt
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    var runVariables = {
      mutation: bulkMutationString,

      /*
       * ใช้ค่า key จาก staged upload parameters
       */
      stagedUploadPath:
        uploadResult.stagedUploadPath
    };

    var runResponse = callShopifyGraphQL_(
      runMutation,
      runVariables
    );

    console.timeEnd("bulkOperationRunMutation");

    var runResult =
      runResponse &&
      runResponse.data &&
      runResponse.data.bulkOperationRunMutation;

    if (!runResult) {
      throw new Error(
        "Shopify ไม่ส่ง bulkOperationRunMutation กลับมา"
      );
    }

    if (
      runResult.userErrors &&
      runResult.userErrors.length > 0
    ) {
      throw new Error(
        "Bulk Operation Error: " +
        JSON.stringify(runResult.userErrors)
      );
    }

    if (!runResult.bulkOperation) {
      throw new Error(
        "Shopify ไม่ได้สร้าง Bulk Operation"
      );
    }

    var bulkOperation =
      runResult.bulkOperation;

    PropertiesService
      .getScriptProperties()
      .setProperty(
        SHOPIFY_PRICE_CONFIG.PROP_BULK_OPERATION_ID,
        bulkOperation.id
      );

    var elapsedSeconds =
      ((Date.now() - startedAt) / 1000).toFixed(2);

    console.log("================================================");
    console.log("🚀 เริ่ม Bulk Operation สำเร็จ");
    console.log(
      "Operation ID : " +
      bulkOperation.id
    );
    console.log(
      "Status       : " +
      bulkOperation.status
    );
    console.log(
      "รายการ       : " +
      totalItems
    );
    console.log(
      "เวลาส่งงาน   : " +
      elapsedSeconds +
      " วินาที"
    );
    console.log(
      "Shopify กำลังอัปเดตราคาเบื้องหลัง"
    );
    console.log("================================================");

  } catch (error) {
    var errorElapsed =
      ((Date.now() - startedAt) / 1000).toFixed(2);

    console.error("================================================");
    console.error("❌ อัปเดตราคาล้มเหลว");
    console.error(
      error && error.stack
        ? error.stack
        : String(error)
    );
    console.error(
      "เวลาที่ใช้ก่อน Error: " +
      errorElapsed +
      " วินาที"
    );
    console.error("================================================");

    throw error;
  }
}


// ============================================================
// OPEN SPREADSHEET
// ============================================================

function openPriceSpreadsheet_() {
  try {
    return SpreadsheetApp.openById(
      SHOPIFY_PRICE_CONFIG.SPREADSHEET_ID
    );
  } catch (error) {
    console.warn(
      "⚠️ openById ไม่สำเร็จ ลองใช้ Active Spreadsheet"
    );

    var activeSpreadsheet =
      SpreadsheetApp.getActiveSpreadsheet();

    if (!activeSpreadsheet) {
      throw new Error(
        "ไม่สามารถเปิด Google Spreadsheet ได้"
      );
    }

    return activeSpreadsheet;
  }
}


// ============================================================
// UPDATE CHECK
// รองรับ:
// - Checkbox false
// - Boolean false
// - ข้อความ FALSE
// - เลข 0
// - ข้อความ 0
// ============================================================

function isUpdateFalse_(value) {
  if (value === false || value === 0) {
    return true;
  }

  var normalized = String(value)
    .trim()
    .toLowerCase();

  return (
    normalized === "false" ||
    normalized === "0"
  );
}


// ============================================================
// FIND COLUMN
// ============================================================

function findColumnIndex_(
  headers,
  possibleNames,
  fallbackIndex
) {
  var normalizedHeaders = headers.map(
    function (header) {
      return normalizeHeader_(header);
    }
  );

  for (var i = 0; i < possibleNames.length; i++) {
    var normalizedName =
      normalizeHeader_(possibleNames[i]);

    var foundIndex =
      normalizedHeaders.indexOf(normalizedName);

    if (foundIndex !== -1) {
      return foundIndex;
    }
  }

  console.warn(
    "⚠️ ไม่พบ Header: " +
    possibleNames.join(" / ") +
    " ใช้ fallback index " +
    fallbackIndex
  );

  return fallbackIndex;
}


function normalizeHeader_(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}


// ============================================================
// PRICE
// ============================================================

function parsePrice_(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  if (
    typeof value === "number" &&
    isFinite(value)
  ) {
    return value;
  }

  var normalized = String(value)
    .replace(/,/g, "")
    .trim();

  if (normalized === "") {
    return null;
  }

  var parsed = Number(normalized);

  return isFinite(parsed)
    ? parsed
    : null;
}


// ============================================================
// VALIDATE SHOPIFY GID
// ============================================================

function isValidProductGid_(value) {
  return String(value).indexOf(
    "gid://shopify/Product/"
  ) === 0;
}


function isValidVariantGid_(value) {
  return String(value).indexOf(
    "gid://shopify/ProductVariant/"
  ) === 0;
}


// ============================================================
// SHOPIFY GRAPHQL
// ============================================================

function callShopifyGraphQL_(
  query,
  variables
) {
  var accessToken =
    getShopifyAccessToken_();

  var url =
    "https://" +
    SHOPIFY_PRICE_CONFIG.SHOP +
    "/admin/api/" +
    SHOPIFY_PRICE_CONFIG.API_VERSION +
    "/graphql.json";

  var response = UrlFetchApp.fetch(
    url,
    {
      method: "post",

      contentType: "application/json",

      headers: {
        "X-Shopify-Access-Token":
          accessToken
      },

      payload: JSON.stringify({
        query: query,
        variables: variables || {}
      }),

      muteHttpExceptions: true
    }
  );

  var responseCode =
    response.getResponseCode();

  var responseText =
    response.getContentText();

  var responseData;

  try {
    responseData =
      JSON.parse(responseText);
  } catch (parseError) {
    throw new Error(
      "Shopify ตอบกลับไม่ใช่ JSON HTTP " +
      responseCode +
      ": " +
      responseText.substring(0, 500)
    );
  }

  if (
    responseCode < 200 ||
    responseCode >= 300
  ) {
    throw new Error(
      "Shopify GraphQL HTTP " +
      responseCode +
      ": " +
      responseText.substring(0, 1000)
    );
  }

  if (
    responseData.errors &&
    responseData.errors.length > 0
  ) {
    throw new Error(
      "GraphQL Error: " +
      JSON.stringify(responseData.errors)
    );
  }

  return responseData;
}


// ============================================================
// ACCESS TOKEN
// ============================================================

function getShopifyAccessToken_() {
  var properties =
    PropertiesService.getScriptProperties();

  var savedToken =
    properties.getProperty(
      SHOPIFY_PRICE_CONFIG.PROP_ACCESS_TOKEN
    );

  var savedExpiry = Number(
    properties.getProperty(
      SHOPIFY_PRICE_CONFIG.PROP_TOKEN_EXPIRY
    ) || 0
  );

  /*
   * ใช้ Token เดิมหากยังไม่หมดอายุ
   */
  if (
    savedToken &&
    savedExpiry > Date.now()
  ) {
    return savedToken;
  }

  console.log(
    "🔑 กำลังขอ Shopify Access Token ใหม่"
  );

  var tokenUrl =
    "https://" +
    SHOPIFY_PRICE_CONFIG.SHOP +
    "/admin/oauth/access_token";

  /*
   * ส่งแบบ application/x-www-form-urlencoded
   */
  var tokenResponse = UrlFetchApp.fetch(
    tokenUrl,
    {
      method: "post",

      payload: {
        grant_type: "client_credentials",
        client_id:
          SHOPIFY_PRICE_CONFIG.CLIENT_ID,
        client_secret:
          SHOPIFY_PRICE_CONFIG.CLIENT_SECRET
      },

      muteHttpExceptions: true
    }
  );

  var tokenStatus =
    tokenResponse.getResponseCode();

  var tokenText =
    tokenResponse.getContentText();

  if (
    tokenStatus < 200 ||
    tokenStatus >= 300
  ) {
    throw new Error(
      "ขอ Shopify Access Token ไม่สำเร็จ HTTP " +
      tokenStatus +
      ": " +
      tokenText.substring(0, 1000)
    );
  }

  var tokenData;

  try {
    tokenData = JSON.parse(tokenText);
  } catch (parseError) {
    throw new Error(
      "Token Response ไม่ใช่ JSON: " +
      tokenText.substring(0, 500)
    );
  }

  if (!tokenData.access_token) {
    throw new Error(
      "Shopify ไม่ส่ง access_token กลับมา: " +
      tokenText.substring(0, 500)
    );
  }

  /*
   * Shopify Client Credentials Token
   * ปกติมีอายุประมาณ 24 ชั่วโมง
   */
  var expiresInSeconds =
    Number(tokenData.expires_in || 86399);

  /*
   * ลบออก 5 นาที ป้องกัน Token หมดอายุระหว่างรัน
   */
  var expiryTimestamp =
    Date.now() +
    expiresInSeconds * 1000 -
    5 * 60 * 1000;

  properties.setProperty(
    SHOPIFY_PRICE_CONFIG.PROP_ACCESS_TOKEN,
    tokenData.access_token
  );

  properties.setProperty(
    SHOPIFY_PRICE_CONFIG.PROP_TOKEN_EXPIRY,
    String(expiryTimestamp)
  );

  console.log(
    "✅ ได้รับ Shopify Access Token ใหม่"
  );

  return tokenData.access_token;
}


// ============================================================
// UPLOAD JSONL
// ============================================================

function uploadJsonlToShopify_(
  stagedTarget,
  jsonlBlob
) {
  if (!stagedTarget || !stagedTarget.url) {
    throw new Error(
      "Staged Upload Target ไม่ถูกต้อง"
    );
  }

  var parameters =
    stagedTarget.parameters || [];

  var formPayload = {};
  var stagedUploadPath = "";

  /*
   * เพิ่ม parameters ที่ Shopify ส่งมา
   */
  for (var i = 0; i < parameters.length; i++) {
    var parameter = parameters[i];

    if (
      !parameter ||
      !parameter.name
    ) {
      continue;
    }

    formPayload[parameter.name] =
      parameter.value;

    /*
     * ค่า key คือ stagedUploadPath
     * ที่ใช้ใน bulkOperationRunMutation
     */
    if (parameter.name === "key") {
      stagedUploadPath =
        parameter.value;
    }
  }

  if (!stagedUploadPath) {
    throw new Error(
      "ไม่พบ key ใน Staged Upload Parameters"
    );
  }

  /*
   * file ต้องถูกเพิ่มท้ายสุด
   */
  formPayload.file = jsonlBlob;

  var uploadResponse = UrlFetchApp.fetch(
    stagedTarget.url,
    {
      method: "post",
      payload: formPayload,
      muteHttpExceptions: true
    }
  );

  var uploadStatus =
    uploadResponse.getResponseCode();

  var uploadText =
    uploadResponse.getContentText();

  /*
   * Shopify มักตอบ 201
   * รองรับทุกค่าในช่วง 2xx
   */
  if (
    uploadStatus < 200 ||
    uploadStatus >= 300
  ) {
    throw new Error(
      "Upload JSONL ล้มเหลว HTTP " +
      uploadStatus +
      ": " +
      uploadText.substring(0, 1000)
    );
  }

  return {
    status: uploadStatus,
    stagedUploadPath: stagedUploadPath
  };
}

// Fallback alias for backward compatibility across Google Apps Script project
function callGraphQL_(queryOrPayload, variables) {
  return callShopifyGraphQL_(queryOrPayload, variables);
}


// ============================================================
// CHECK BULK OPERATION STATUS
// ============================================================

function checkCurrentPriceBulkOperation() {
  console.log("================================================");
  console.log("🔍 ตรวจสอบสถานะ Bulk Operation");
  console.log("================================================");

  try {
    var properties =
      PropertiesService.getScriptProperties();

    var operationId =
      properties.getProperty(
        SHOPIFY_PRICE_CONFIG.PROP_BULK_OPERATION_ID
      );

    if (!operationId) {
      console.warn(
        "⚠️ ไม่พบ Bulk Operation ID ที่บันทึกไว้"
      );

      return;
    }

    var query = `
      query checkBulkOperation($id: ID!) {
        bulkOperation(id: $id) {
          id
          status
          errorCode
          type
          objectCount
          rootObjectCount
          fileSize
          url
          partialDataUrl
          createdAt
          completedAt
        }
      }
    `;

    var response = callShopifyGraphQL_(
      query,
      {
        id: operationId
      }
    );

    var operation =
      response &&
      response.data &&
      response.data.bulkOperation;

    if (!operation) {
      console.warn(
        "⚠️ Shopify ไม่พบ Bulk Operation นี้"
      );

      return;
    }

    console.log(
      "Operation ID    : " +
      operation.id
    );

    console.log(
      "Status          : " +
      operation.status
    );

    console.log(
      "Processed       : " +
      operation.objectCount
    );

    console.log(
      "Root Objects    : " +
      operation.rootObjectCount
    );

    console.log(
      "Error Code      : " +
      (operation.errorCode || "-")
    );

    console.log(
      "Created At      : " +
      operation.createdAt
    );

    console.log(
      "Completed At    : " +
      (operation.completedAt || "-")
    );

    console.log(
      "Result URL      : " +
      (operation.url || "-")
    );

    console.log(
      "Partial URL     : " +
      (operation.partialDataUrl || "-")
    );

    console.log("================================================");

  } catch (error) {
    console.error(
      error && error.stack
        ? error.stack
        : String(error)
    );

    throw error;
  }
}


// ============================================================
// CLEAR SAVED TOKEN
// ใช้เมื่อเปลี่ยน Client Secret หรือ Token มีปัญหา
// ============================================================

function clearShopifyPriceToken() {
  var properties =
    PropertiesService.getScriptProperties();

  properties.deleteProperty(
    SHOPIFY_PRICE_CONFIG.PROP_ACCESS_TOKEN
  );

  properties.deleteProperty(
    SHOPIFY_PRICE_CONFIG.PROP_TOKEN_EXPIRY
  );

  console.log(
    "✅ ล้าง Shopify Access Token ที่บันทึกไว้แล้ว"
  );
}
