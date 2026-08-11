function importColumnsBIK() {
  const startedAt = Date.now();

  // ==================================================
  // ตั้งค่าไฟล์ต้นทาง
  // ==================================================
  const SOURCE_ID =
    "1-7ap--3aphttTb8M0cXYvVYmRGtZQKRxoUW3nvwuUNA";

  const SOURCE_SHEET = "Active";

  // ==================================================
  // ตั้งค่าไฟล์ปลายทาง
  // ==================================================
  const TARGET_ID =
    "1FPEsVsZbIPmwEFOgnPJ8W9t7yKIS4NX5lY83gqskhcQ";

  const TARGET_SHEET = "Spare Parts1";

  const READ_CHUNK_SIZE = 5000;
  const WRITE_CHUNK_SIZE = 5000;

  const lock = LockService.getScriptLock();

  if (!lock.tryLock(1000)) {
    throw new Error("มีสคริปต์ importColumnsBIK กำลังทำงานอยู่");
  }

  try {
    console.log("===== START importColumnsBIK =====");

    // ==================================================
    // 1. อ่าน Column Q เพื่อหาแถวสุดท้าย
    // ==================================================
    console.log("1/7 ตรวจสอบจำนวนแถวจาก Column Q");

    const qResult = retrySheetsApi_(
      function () {
        return Sheets.Spreadsheets.Values.get(
          SOURCE_ID,
          `'${SOURCE_SHEET}'!Q1:Q`,
          {
            majorDimension: "ROWS",
            valueRenderOption: "UNFORMATTED_VALUE"
          }
        );
      },
      "ตรวจสอบ Column Q"
    );

    const qValues = qResult.values || [];
    const lastRow = qValues.length;

    if (lastRow < 1) {
      throw new Error(
        `ชีต "${SOURCE_SHEET}" ไม่มีข้อมูลใน Column Q`
      );
    }

    console.log("พบข้อมูลถึงแถว: " + lastRow);

    // ==================================================
    // 2. ตรวจสอบชีตปลายทางและจำนวนแถว
    // ==================================================
    console.log("2/7 ตรวจสอบชีตปลายทาง");

    const targetMetadata = retrySheetsApi_(
      function () {
        return Sheets.Spreadsheets.get(
          TARGET_ID,
          {
            fields:
              "sheets(properties(sheetId,title,gridProperties(rowCount)))"
          }
        );
      },
      "ตรวจสอบชีตปลายทาง"
    );

    const targetSheetInfo =
      (targetMetadata.sheets || []).find(function (sheet) {
        return sheet.properties.title === TARGET_SHEET;
      });

    if (!targetSheetInfo) {
      const sheetNames = (targetMetadata.sheets || [])
        .map(function (sheet) {
          return sheet.properties.title;
        })
        .join(", ");

      throw new Error(
        `ไม่พบชีตปลายทาง "${TARGET_SHEET}" ` +
        `ชีตที่มีอยู่: ${sheetNames}`
      );
    }

    const targetSheetId =
      targetSheetInfo.properties.sheetId;

    console.log(
      `พบชีตปลายทาง "${TARGET_SHEET}" ` +
      `Sheet ID: ${targetSheetId}`
    );

    // ==================================================
    // 3. อ่าน B, C, I, K, Q แบบแบ่งช่วง
    // ==================================================
    console.log("3/7 เริ่มอ่านข้อมูลแบบแบ่งช่วง");

    const output = [];

    for (
      let startRow = 1;
      startRow <= lastRow;
      startRow += READ_CHUNK_SIZE
    ) {
      const endRow = Math.min(
        startRow + READ_CHUNK_SIZE - 1,
        lastRow
      );

      console.log(
        `กำลังอ่านแถว ${startRow}-${endRow}`
      );

      const response = retrySheetsApi_(
        function () {
          return Sheets.Spreadsheets.Values.batchGet(
            SOURCE_ID,
            {
              ranges: [
                `'${SOURCE_SHEET}'!B${startRow}:C${endRow}`,
                `'${SOURCE_SHEET}'!I${startRow}:I${endRow}`,
                `'${SOURCE_SHEET}'!K${startRow}:K${endRow}`,
                `'${SOURCE_SHEET}'!Q${startRow}:Q${endRow}`
              ],
              majorDimension: "ROWS",
              valueRenderOption: "UNFORMATTED_VALUE"
            }
          );
        },
        `อ่านแถว ${startRow}-${endRow}`
      );

      const dataBC =
        response.valueRanges?.[0]?.values || [];

      const dataI =
        response.valueRanges?.[1]?.values || [];

      const dataK =
        response.valueRanges?.[2]?.values || [];

      const dataQ =
        response.valueRanges?.[3]?.values || [];

      const numberOfRows =
        endRow - startRow + 1;

      for (let i = 0; i < numberOfRows; i++) {
        const actualRow = startRow + i;

        const columnB =
          dataBC[i]?.[0] ?? "";

        const columnC =
          dataBC[i]?.[1] ?? "";

        const columnI =
          dataI[i]?.[0] ?? "";

        const columnK =
          dataK[i]?.[0] ?? "";

        const type = String(
          dataQ[i]?.[0] ?? ""
        ).trim();

        // หัวตารางแถวที่ 1
        if (actualRow === 1) {
          output.push([
            columnB,
            columnC,
            columnI,
            columnK
          ]);

          continue;
        }

        // เอาเฉพาะอะไหล่หรือสินค้าสิ้นเปลือง
        if (
          type === "อะไหล่" ||
          type === "สินค้าสิ้นเปลือง"
        ) {
          output.push([
            columnB,
            columnC,
            columnI,
            columnK
          ]);
        }
      }

      console.log(
        `อ่านถึงแถว ${endRow}/${lastRow} ` +
        `พบข้อมูลตรงเงื่อนไข ${output.length - 1} รายการ`
      );
    }

    if (output.length === 0) {
      throw new Error("ไม่พบหัวตารางหรือข้อมูลสำหรับนำเข้า");
    }

    console.log(
      "4/7 เตรียมข้อมูลสำเร็จ: " +
      (output.length - 1) +
      " รายการ"
    );

    // ==================================================
    // 4. เพิ่มจำนวนแถวปลายทาง หากพื้นที่ไม่พอ
    // ==================================================
    const requiredRows = output.length;

    const currentRowCount =
      targetSheetInfo.properties.gridProperties.rowCount;

    if (currentRowCount < requiredRows) {
      console.log(
        `5/7 เพิ่มแถวจาก ${currentRowCount} ` +
        `เป็น ${requiredRows}`
      );

      retrySheetsApi_(
        function () {
          return Sheets.Spreadsheets.batchUpdate(
            {
              requests: [
                {
                  updateSheetProperties: {
                    properties: {
                      sheetId: targetSheetId,
                      gridProperties: {
                        rowCount: requiredRows
                      }
                    },
                    fields: "gridProperties.rowCount"
                  }
                }
              ]
            },
            TARGET_ID
          );
        },
        "เพิ่มจำนวนแถวปลายทาง"
      );
    } else {
      console.log(
        "5/7 จำนวนแถวปลายทางเพียงพอ"
      );
    }

    // ==================================================
    // 5. ล้างข้อมูลเดิมเฉพาะ A:D
    // ==================================================
    console.log("6/7 ล้างข้อมูลเดิม A:D");

    retrySheetsApi_(
      function () {
        return Sheets.Spreadsheets.Values.clear(
          {},
          TARGET_ID,
          `'${TARGET_SHEET}'!A:D`
        );
      },
      "ล้างข้อมูลเดิม"
    );

    // ==================================================
    // 6. เขียนข้อมูลแบบแบ่งช่วง
    // ==================================================
    console.log("7/7 เริ่มเขียนข้อมูล");

    for (
      let startIndex = 0;
      startIndex < output.length;
      startIndex += WRITE_CHUNK_SIZE
    ) {
      const batch = output.slice(
        startIndex,
        startIndex + WRITE_CHUNK_SIZE
      );

      const destinationStartRow =
        startIndex + 1;

      const destinationEndRow =
        destinationStartRow + batch.length - 1;

      const destinationRange =
        `'${TARGET_SHEET}'!A${destinationStartRow}` +
        `:D${destinationEndRow}`;

      retrySheetsApi_(
        function () {
          return Sheets.Spreadsheets.Values.update(
            {
              majorDimension: "ROWS",
              values: batch
            },
            TARGET_ID,
            destinationRange,
            {
              valueInputOption: "RAW",
              includeValuesInResponse: false
            }
          );
        },
        `เขียนแถว ${destinationStartRow}-${destinationEndRow}`
      );

      console.log(
        `เขียนแล้ว ${destinationEndRow}/${output.length} แถว`
      );
    }

    console.log(
      `นำเข้าข้อมูลสำเร็จ ${output.length - 1} รายการ`
    );

    console.log(
      "ใช้เวลาทั้งหมด: " +
      ((Date.now() - startedAt) / 1000).toFixed(2) +
      " วินาที"
    );

    console.log("===== FINISH =====");

  } catch (error) {
    console.error("ERROR: " + error.message);
    console.error(error.stack);
    throw error;

  } finally {
    lock.releaseLock();
  }
}


/**
 * ลองเรียก Sheets API ใหม่อัตโนมัติ
 * เมื่อเจอ 429, 500, 502, 503 หรือ 504
 */
function retrySheetsApi_(callback, actionName) {
  const maxAttempts = 5;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    try {
      return callback();

    } catch (error) {
      const message =
        String(error.message || error);

      const canRetry =
        /429|500|502|503|504|service is currently unavailable|internal error|backend error|rate limit/i
          .test(message);

      console.log(
        `${actionName} ล้มเหลวครั้งที่ ` +
        `${attempt}/${maxAttempts}: ${message}`
      );

      if (
        !canRetry ||
        attempt === maxAttempts
      ) {
        throw error;
      }

      const waitMilliseconds =
        Math.min(
          Math.pow(2, attempt) * 1000 +
          Math.floor(Math.random() * 1000),
          32000
        );

      console.log(
        `รอ ${(waitMilliseconds / 1000).toFixed(1)} ` +
        `วินาทีแล้วลองใหม่`
      );

      Utilities.sleep(waitMilliseconds);
    }
  }
}