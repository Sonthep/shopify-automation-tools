function updateInventoryWebApiChunked() {
  const startedAt = Date.now();

  const SOURCE_FILE_ID =
    "1hfHjhC7WdjVDT7qHt19PL8AnxlhTJ6rbbh-N4UBQJBA";

  const DESTINATION_FILE_ID =
    "1tUfMjcduyIwy8F0hpdw1FCiwwNb9SLL84gukrQltd8I";

  const SOURCE_SHEET = "Products Export";
  const DESTINATION_SHEET = "inventory web";

  // ดึง LAST_ROW จาก sheet จริงอัตโนมัติ (ไม่ hardcode)
  const colAMeta = Sheets.Spreadsheets.Values.get(
    SOURCE_FILE_ID,
    "'" + SOURCE_SHEET + "'!A:A",
    { valueRenderOption: "UNFORMATTED_VALUE" }
  );
  const LAST_ROW = (colAMeta.values || []).length;
  console.log("LAST_ROW (จาก sheet จริง): " + LAST_ROW);


  // ลดเหลือ 3,000 ได้ หากยังเจอ 503
  const READ_CHUNK_SIZE = 5000;
  const WRITE_CHUNK_SIZE = 5000;

  const lock = LockService.getScriptLock();

  if (!lock.tryLock(1000)) {
    throw new Error("มีสคริปต์ชุดนี้กำลังทำงานอยู่แล้ว");
  }

  try {
    console.log("===== START =====");
    console.log("เริ่มอ่านข้อมูลแบบแบ่งช่วง");

    const output = [[
      "Good ID",
      "Variant SKU",
      "Inventory quantity",
      "Inventory Item ID"
    ]];

    let totalRead = 0;

    /*
     * อ่านทีละ 5,000 แถว
     * A:B = Good ID, Variant SKU
     * E   = Inventory Item ID
     * O   = Inventory quantity
     */
    for (
      let startRow = 2;
      startRow <= LAST_ROW;
      startRow += READ_CHUNK_SIZE
    ) {
      const endRow = Math.min(
        startRow + READ_CHUNK_SIZE - 1,
        LAST_ROW
      );

      console.log(
        "กำลังอ่านแถว " + startRow + "-" + endRow
      );

      const response = retrySheetsApi_(
        function () {
          return Sheets.Spreadsheets.Values.batchGet(
            SOURCE_FILE_ID,
            {
              ranges: [
                "'" + SOURCE_SHEET + "'!A" +
                  startRow + ":B" + endRow,

                "'" + SOURCE_SHEET + "'!E" +
                  startRow + ":E" + endRow,

                "'" + SOURCE_SHEET + "'!O" +
                  startRow + ":O" + endRow
              ],
              majorDimension: "ROWS",
              valueRenderOption: "UNFORMATTED_VALUE"
            }
          );
        },
        "อ่านแถว " + startRow + "-" + endRow
      );

      const dataAB =
        response.valueRanges?.[0]?.values || [];

      const dataE =
        response.valueRanges?.[1]?.values || [];

      const dataO =
        response.valueRanges?.[2]?.values || [];

      const numberOfRows = endRow - startRow + 1;

      for (let i = 0; i < numberOfRows; i++) {
        const goodId = dataAB[i]?.[0] ?? "";
        const sku = dataAB[i]?.[1] ?? "";
        const inventoryItemId = dataE[i]?.[0] ?? "";
        const inventory = dataO[i]?.[0] ?? 0;

        if (
          sku === "" ||
          sku === null ||
          String(sku).trim() === ""
        ) {
          continue;
        }

        output.push([
          goodId,
          sku,
          inventory === "" ? 0 : inventory,
          inventoryItemId
        ]);
      }

      totalRead += numberOfRows;

      console.log(
        "อ่านแล้ว " +
        totalRead +
        "/" +
        (LAST_ROW - 1) +
        " แถว"
      );
    }

    console.log(
      "เตรียมข้อมูลเสร็จ: " +
      (output.length - 1) +
      " รายการ"
    );

    /*
     * อ่านสำเร็จครบก่อนค่อยล้างปลายทาง
     * ป้องกันข้อมูลปลายทางหายหากต้นทางอ่านไม่สำเร็จ
     */
    console.log("กำลังล้างข้อมูลเดิม A:D");

    retrySheetsApi_(
      function () {
        return Sheets.Spreadsheets.Values.clear(
          {},
          DESTINATION_FILE_ID,
          "'" + DESTINATION_SHEET + "'!A:D"
        );
      },
      "ล้างข้อมูลปลายทาง"
    );

    console.log("เริ่มเขียนข้อมูลแบบแบ่งช่วง");

    for (
      let startIndex = 0;
      startIndex < output.length;
      startIndex += WRITE_CHUNK_SIZE
    ) {
      const batch = output.slice(
        startIndex,
        startIndex + WRITE_CHUNK_SIZE
      );

      const destinationStartRow = startIndex + 1;
      const destinationEndRow =
        destinationStartRow + batch.length - 1;

      const destinationRange =
        "'" + DESTINATION_SHEET + "'!A" +
        destinationStartRow +
        ":D" +
        destinationEndRow;

      retrySheetsApi_(
        function () {
          return Sheets.Spreadsheets.Values.update(
            {
              majorDimension: "ROWS",
              values: batch
            },
            DESTINATION_FILE_ID,
            destinationRange,
            {
              valueInputOption: "RAW",
              includeValuesInResponse: false
            }
          );
        },
        "เขียนแถว " +
          destinationStartRow +
          "-" +
          destinationEndRow
      );

      console.log(
        "เขียนแล้ว " +
        Math.min(
          startIndex + WRITE_CHUNK_SIZE,
          output.length
        ) +
        "/" +
        output.length +
        " แถว"
      );
    }

    console.log(
      "สำเร็จทั้งหมด ใช้เวลา " +
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
 * ลองเรียก Sheets API ซ้ำอัตโนมัติ
 * เมื่อเจอปัญหาชั่วคราว 429, 500, 503, 504
 */
function retrySheetsApi_(callback, actionName) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return callback();

    } catch (error) {
      const message = String(error.message || error);

      const retryable =
        /429|500|502|503|504|service is currently unavailable|internal error|backend error|rate limit/i
          .test(message);

      console.log(
        actionName +
        " ล้มเหลว ครั้งที่ " +
        attempt +
        "/" +
        maxAttempts +
        ": " +
        message
      );

      if (!retryable || attempt === maxAttempts) {
        throw error;
      }

      // 2, 4, 8, 16 วินาที + เวลาสุ่ม
      const waitMilliseconds =
        Math.min(
          Math.pow(2, attempt) * 1000 +
          Math.floor(Math.random() * 1000),
          32000
        );

      console.log(
        "รอ " +
        (waitMilliseconds / 1000).toFixed(1) +
        " วินาที แล้วลองใหม่"
      );

      Utilities.sleep(waitMilliseconds);
    }
  }

  throw new Error(actionName + " ไม่สำเร็จ");
}