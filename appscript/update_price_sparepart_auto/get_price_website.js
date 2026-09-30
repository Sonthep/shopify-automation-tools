// ============================================================
// CONFIG
// ============================================================

var SOURCE_SPREADSHEET_ID =
  "1hfHjhC7WdjVDT7qHt19PL8AnxlhTJ6rbbh-N4UBQJBA";

var SOURCE_SHEET_NAME = "Products Export";
var TARGET_SHEET_NAME = "price website";


// ============================================================
// MENU
// ============================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("⚙️ Price Website Tools")
    .addItem(
      "นำเข้า A, B, C, D, M, N",
      "importABMNWithSheetsApi"
    )
    .addToUi();
}


// ============================================================
// MAIN
// ============================================================

function importABMNWithSheetsApi() {
  var startedAt = new Date();

  try {
    consoleLog_("START", "เริ่มต้นนำเข้าข้อมูล A, B, C, D, M, N");

    // ---- ดึง ID จาก active spreadsheet (เร็ว ไม่โหลดข้อมูลชีต) ----
    var targetSpreadsheetId =
      SpreadsheetApp.getActiveSpreadsheet().getId();

    consoleLog_("TARGET", "Spreadsheet ID: " + targetSpreadsheetId);

    // ========================================================
    // STEP 1: ตรวจสอบ/สร้างชีตปลายทาง ด้วย Sheets API
    // ========================================================

    var targetMeta = Sheets.Spreadsheets.get(
      targetSpreadsheetId,
      { fields: "sheets.properties" }
    );

    var targetSheetProp = null;
    (targetMeta.sheets || []).forEach(function(s) {
      if (s.properties && s.properties.title === TARGET_SHEET_NAME) {
        targetSheetProp = s.properties;
      }
    });

    var targetSheetId;

    if (!targetSheetProp) {
      consoleLog_("CREATE SHEET", 'สร้างชีต "' + TARGET_SHEET_NAME + '"');
      var createResp = Sheets.Spreadsheets.batchUpdate(
        { requests: [{ addSheet: { properties: { title: TARGET_SHEET_NAME } } }] },
        targetSpreadsheetId
      );
      targetSheetId = createResp.replies[0].addSheet.properties.sheetId;
      consoleLog_("CREATE SHEET", "สร้างชีตสำเร็จ sheetId=" + targetSheetId);
    } else {
      targetSheetId = targetSheetProp.sheetId;
      consoleLog_("TARGET SHEET", 'พบชีต "' + TARGET_SHEET_NAME + '" sheetId=' + targetSheetId);
    }

    // ========================================================
    // STEP 2: ตรวจสอบ/นับแถวในชีตต้นทาง ด้วย Sheets API
    // ========================================================

    consoleLog_("SOURCE", "กำลังตรวจสอบชีตต้นทาง");

    var srcMeta = Sheets.Spreadsheets.get(
      SOURCE_SPREADSHEET_ID,
      { fields: "sheets.properties.title" }
    );

    var sourceExists = (srcMeta.sheets || []).some(function(s) {
      return s.properties && s.properties.title === SOURCE_SHEET_NAME;
    });

    if (!sourceExists) {
      throw new Error('ไม่พบชีตต้นทาง "' + SOURCE_SHEET_NAME + '"');
    }

    var colAResp = Sheets.Spreadsheets.Values.get(
      SOURCE_SPREADSHEET_ID,
      "'" + escapeSheetName_(SOURCE_SHEET_NAME) + "'!A:A",
      { majorDimension: "COLUMNS", valueRenderOption: "UNFORMATTED_VALUE" }
    );

    var lastRow = ((colAResp.values && colAResp.values[0]) || []).length;

    if (lastRow < 1) {
      consoleLog_("NO DATA", "ไม่พบข้อมูลในชีตต้นทาง");
      return;
    }

    consoleLog_("SOURCE", "พบข้อมูล " + formatNumber_(lastRow) + " แถว");

    // ========================================================
    // STEP 3: อ่าน A, B, C, D, M, N ด้วย Sheets API (batchGet)
    // ========================================================

    consoleLog_("READ", "กำลังอ่านคอลัมน์ A, B, C, D, M, N");

    var esc = escapeSheetName_(SOURCE_SHEET_NAME);
    var response = Sheets.Spreadsheets.Values.batchGet(
      SOURCE_SPREADSHEET_ID,
      {
        ranges: [
          "'" + esc + "'!A1:A" + lastRow,
          "'" + esc + "'!B1:B" + lastRow,
          "'" + esc + "'!C1:C" + lastRow,
          "'" + esc + "'!D1:D" + lastRow,
          "'" + esc + "'!M1:M" + lastRow,
          "'" + esc + "'!N1:N" + lastRow
        ],
        majorDimension: "COLUMNS",
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "FORMATTED_STRING"
      }
    );

    consoleLog_("READ COMPLETE", "อ่านข้อมูลจากต้นทางสำเร็จ");

    var vr = response.valueRanges || [];
    var colA = getColumnValues_(vr, 0);
    var colB = getColumnValues_(vr, 1);
    var colC = getColumnValues_(vr, 2);
    var colD = getColumnValues_(vr, 3);
    var colM = getColumnValues_(vr, 4);
    var colN = getColumnValues_(vr, 5);
    var maxRows = Math.max(colA.length, colB.length, colC.length,
                           colD.length, colM.length, colN.length);

    if (maxRows === 0) {
      consoleLog_("NO DATA", "ไม่พบค่าที่สามารถนำเข้าได้");
      return;
    }

    // ========================================================
    // STEP 4: รวมข้อมูล
    // ========================================================

    consoleLog_("PROCESS", "กำลังจัดเตรียมข้อมูล " + formatNumber_(maxRows) + " แถว");

    var output = new Array(maxRows);
    for (var i = 0; i < maxRows; i++) {
      output[i] = [
        getSafeValue_(colA, i),
        getSafeValue_(colB, i),
        getSafeValue_(colC, i),
        getSafeValue_(colD, i),
        roundPrice_(getSafeValue_(colM, i)),
        roundPrice_(getSafeValue_(colN, i))
      ];
      if ((i + 1) % 10000 === 0 || i === maxRows - 1) {
        var pct = Math.round(((i + 1) / maxRows) * 100);
        consoleLog_("PROCESS", formatNumber_(i + 1) + " / " + formatNumber_(maxRows) + " แถว (" + pct + "%)");
      }
    }

    // ========================================================
    // STEP 5: ล้างและเขียนข้อมูล ด้วย Sheets API
    // ========================================================

    consoleLog_("CLEAR", "กำลังล้างข้อมูลเดิม");

    Sheets.Spreadsheets.Values.clear(
      {},
      targetSpreadsheetId,
      "'" + escapeSheetName_(TARGET_SHEET_NAME) + "'!A:F"
    );

    consoleLog_("WRITE", "กำลังเขียนข้อมูล " + formatNumber_(maxRows) + " แถว");

    var writeResp = Sheets.Spreadsheets.Values.batchUpdate(
      {
        valueInputOption: "RAW",
        data: [{
          range: "'" + escapeSheetName_(TARGET_SHEET_NAME) + "'!A1:F" + maxRows,
          majorDimension: "ROWS",
          values: output
        }]
      },
      targetSpreadsheetId
    );

    var updatedRows = writeResp.totalUpdatedRows || maxRows;
    consoleLog_("WRITE COMPLETE", "เขียนข้อมูลสำเร็จ " + formatNumber_(updatedRows) + " แถว");

    // ========================================================
    // STEP 6: จัดรูปแบบหัวตาราง (เฉพาะครั้งแรกที่สร้างชีตใหม่)
    // ========================================================

    if (!targetSheetProp) {
      // สร้างชีตใหม่ → ต้องจัดรูปแบบ
      consoleLog_("FORMAT", "จัดรูปแบบ Bold + Freeze row 1 (ชีตใหม่)");

      try {
        Sheets.Spreadsheets.batchUpdate(
          {
            requests: [
              {
                updateSheetProperties: {
                  properties: { sheetId: targetSheetId, gridProperties: { frozenRowCount: 1 } },
                  fields: "gridProperties.frozenRowCount"
                }
              },
              {
                repeatCell: {
                  range: { sheetId: targetSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 },
                  cell: { userEnteredFormat: { textFormat: { bold: true } } },
                  fields: "userEnteredFormat.textFormat.bold"
                }
              }
            ]
          },
          targetSpreadsheetId
        );
      } catch (fmtErr) {
        // format ล้มเหลวไม่ถือว่า error หลัก — ข้อมูลเขียนเสร็จแล้ว
        consoleLog_("FORMAT WARN", "จัดรูปแบบไม่สำเร็จ (ไม่กระทบข้อมูล): " + fmtErr.message);
      }
    } else {
      consoleLog_("FORMAT", "ข้ามการจัดรูปแบบ (ชีตมีอยู่แล้ว)");
    }

    // ========================================================
    // FINISH
    // ========================================================

    var elapsed = ((new Date().getTime() - startedAt.getTime()) / 1000).toFixed(2);
    consoleLog_("COMPLETED", "นำเข้าข้อมูลสำเร็จ " + formatNumber_(updatedRows) + " แถว ใช้เวลา " + elapsed + " วินาที");

  } catch (error) {
    var errorMessage = error && error.message ? error.message : String(error);
    console.error("[ERROR] " + errorMessage);
    throw error;
  }
}

// ============================================================
// CONSOLE LOG
// ============================================================

function consoleLog_(
  status,
  message
) {
  var timestamp =
    Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone() ||
        "Asia/Bangkok",
      "HH:mm:ss"
    );

  console.log(
    "[" +
      timestamp +
      "] [" +
      status +
      "] " +
      message
  );
}


// ============================================================
// GET COLUMN VALUES
// ============================================================

function getColumnValues_(
  valueRanges,
  index
) {
  if (
    !valueRanges[index] ||
    !valueRanges[index].values ||
    valueRanges[index].values.length === 0
  ) {
    return [];
  }

  return (
    valueRanges[index].values[0] ||
    []
  );
}


// ============================================================
// SAFE VALUE
// ============================================================

function getSafeValue_(
  array,
  index
) {
  if (
    index >= array.length ||
    array[index] === undefined ||
    array[index] === null
  ) {
    return "";
  }

  return array[index];
}


// ============================================================
// ENSURE SHEET SIZE
// ============================================================

function ensureSheetSize_(
  sheet,
  requiredRows,
  requiredColumns
) {
  var currentRows =
    sheet.getMaxRows();

  var currentColumns =
    sheet.getMaxColumns();

  if (
    currentRows <
    requiredRows
  ) {
    sheet.insertRowsAfter(
      currentRows,
      requiredRows - currentRows
    );
  }

  if (
    currentColumns <
    requiredColumns
  ) {
    sheet.insertColumnsAfter(
      currentColumns,
      requiredColumns -
        currentColumns
    );
  }
}


// ============================================================
// FORMAT NUMBER
// ============================================================

function formatNumber_(value) {
  return Number(value || 0)
    .toLocaleString("en-US");
}


// ============================================================
// ROUND PRICE (ตัดทศนิยม)
// ============================================================

function roundPrice_(value) {
  if (
    value === "" ||
    value === null ||
    value === undefined
  ) {
    return "";
  }

  var num = Number(value);

  return isNaN(num) ? value : Math.round(num);
}


// ============================================================
// ESCAPE SHEET NAME
// ============================================================

function escapeSheetName_(
  sheetName
) {
  return String(sheetName)
    .replace(/'/g, "''");
}