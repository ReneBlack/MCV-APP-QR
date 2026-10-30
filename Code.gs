/** Public web app. The spreadsheet is never sent to the browser. */
const SHEET_NAME_ = 'Registros';
const HEADERS_ = ['Nombre', 'Objeto retirado', 'Fecha y hora', 'ID de registro'];

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Retiros del almacén')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Run once from the script editor bound to the destination spreadsheet. */
function setup_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Abre este proyecto desde Extensiones → Apps Script en tu planilla.');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    let sheet = spreadsheet.getSheetByName(SHEET_NAME_);
    if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME_);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS_);
    }
    assertHeaders_(sheet);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    sheet.setColumnWidth(1, 180);
    sheet.setColumnWidth(2, 320);
    sheet.setColumnWidth(3, 190);
    sheet.hideColumns(4);
    PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', spreadsheet.getId());
    return 'Preparado. Zona horaria de la planilla: ' + spreadsheet.getSpreadsheetTimeZone();
  } finally {
    lock.releaseLock();
  }
}

function registerWithdrawal(payload) {
  const data = validate_(payload);
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) throw new Error('El formulario aún no está configurado. Avisa al encargado del almacén.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Hay otro registro en curso. Espera unos segundos y vuelve a intentarlo.');
  try {
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const sheet = spreadsheet.getSheetByName(SHEET_NAME_);
    assertHeaders_(sheet);
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const existing = sheet.getRange(2, 4, lastRow - 1, 1)
        .createTextFinder(data.requestId).matchEntireCell(true).findNext();
      if (existing) {
        const values = sheet.getRange(existing.getRow(), 1, 1, 3).getValues()[0];
        if (values[0] !== data.name || values[1] !== data.item) {
          throw new Error('Este envío ya se registró con otros datos. Recarga la página para registrar un retiro nuevo.');
        }
        return receipt_(values[2], spreadsheet.getSpreadsheetTimeZone(), true);
      }
    }
    const now = new Date();
    const row = lastRow + 1;
    // Explicit text formatting plus escaping prevents spreadsheet formula injection.
    sheet.getRange(row, 1, 1, 2).setNumberFormat('@');
    sheet.appendRow([safeText_(data.name), safeText_(data.item), now, data.requestId]);
    sheet.getRange(row, 3).setNumberFormat('dd/MM/yyyy HH:mm:ss');
    SpreadsheetApp.flush();
    return receipt_(now, spreadsheet.getSpreadsheetTimeZone(), false);
  } finally {
    lock.releaseLock();
  }
}

function validate_(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('El registro no es válido. Recarga la página.');
  if (typeof payload.name !== 'string' || typeof payload.item !== 'string') {
    throw new Error('Completa tu nombre y el objeto retirado.');
  }
  const name = payload.name.trim().replace(/\s+/g, ' ');
  const item = payload.item.trim();
  if (!name || !item) throw new Error('Completa tu nombre y el objeto retirado.');
  if (name.length > 100) throw new Error('El nombre debe tener como máximo 100 caracteres.');
  if (item.length > 500) throw new Error('El detalle debe tener como máximo 500 caracteres.');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(name + item)) {
    throw new Error('El texto contiene caracteres no permitidos.');
  }
  if (typeof payload.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(payload.requestId)) {
    throw new Error('No se pudo identificar el envío. Recarga la página.');
  }
  return { name: name, item: item, requestId: payload.requestId };
}

function safeText_(text) {
  return /^[=+\-@']/.test(text) ? "'" + text : text;
}

function assertHeaders_(sheet) {
  if (!sheet || HEADERS_.some(function (header, index) {
    return sheet.getRange(1, index + 1).getValue() !== header;
  })) {
    throw new Error('La hoja Registros no está preparada. Avisa al encargado del almacén.');
  }
}

function receipt_(date, timezone, duplicate) {
  return {
    ok: true,
    duplicate: duplicate,
    registeredAt: Utilities.formatDate(date, timezone, 'dd/MM/yyyy HH:mm:ss')
  };
}
