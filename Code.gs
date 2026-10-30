/** Public web app. The spreadsheet is never sent to the browser. */
const SHEET_NAME_ = 'Registros';
const HEADERS_ = ['Nombre', 'Objeto retirado', 'Fecha y hora', 'ID de registro'];

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Retiros del almacén')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Editor entry point: Apps Script hides underscore-suffixed functions in its selector. */
function configurarPlanilla() {
  return setup_();
}

/** Requires the bound spreadsheet's editor context, which web app calls do not have. */
function setup_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Abre este proyecto desde Extensiones → Apps Script en tu planilla.');
  const properties = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (properties.getProperty('MONTHLY_ENABLED') === 'true') {
      if (properties.getProperty('SPREADSHEET_ID') !== spreadsheet.getId()) {
        throw new Error('Los respaldos mensuales pertenecen a otra planilla. No se puede cambiar el destino sin una migración.');
      }
      const active = spreadsheet.getSheetById(Number(properties.getProperty('ACTIVE_SHEET_ID')));
      assertHeaders_(active);
      prepareSheet_(active);
      return 'Preparado. Zona horaria de la planilla: ' + spreadsheet.getSpreadsheetTimeZone();
    }
    let sheet = spreadsheet.getSheetByName(SHEET_NAME_);
    if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME_);
    prepareSheet_(sheet);
    properties.setProperty('SPREADSHEET_ID', spreadsheet.getId());
    return 'Preparado. Zona horaria de la planilla: ' + spreadsheet.getSpreadsheetTimeZone();
  } finally {
    lock.releaseLock();
  }
}

function registerWithdrawal(payload) {
  const data = validate_(payload);
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = properties.getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) throw new Error('El formulario aún no está configurado. Avisa al encargado del almacén.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Hay otro registro en curso. Espera unos segundos y vuelve a intentarlo.');
  try {
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const now = new Date();
    closeMonthlyPeriod_(spreadsheet, properties, now);
    const sheet = spreadsheet.getSheetByName(SHEET_NAME_);
    assertHeaders_(sheet);
    const existing = findWithdrawal_(spreadsheet, properties, sheet, data);
    if (existing) return receipt_(existing[2], spreadsheet.getSpreadsheetTimeZone(), true);
    const lastRow = sheet.getLastRow();
    const row = lastRow + 1;
    ensureRowCapacity_(sheet, row);
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

/** Run from the bound editor; the public web app has no active spreadsheet. */
function configurarRespaldoMensual() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Abre este proyecto desde Extensiones → Apps Script en tu planilla.');
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty('SPREADSHEET_ID') !== spreadsheet.getId()) {
    throw new Error('Ejecuta configurarPlanilla primero en esta misma planilla.');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    let folder;
    const folderId = properties.getProperty('BACKUP_FOLDER_ID');
    if (folderId) {
      folder = DriveApp.getFolderById(folderId);
    } else {
      folder = DriveApp.createFolder('Respaldos del almacén');
      properties.setProperty('BACKUP_FOLDER_ID', folder.getId());
    }
    assertPrivateFolder_(folder);
    if (properties.getProperty('MONTHLY_ENABLED') !== 'true') {
      const sheet = spreadsheet.getSheetByName(SHEET_NAME_);
      assertHeaders_(sheet);
      properties.setProperty('ACTIVE_MONTH', monthKey_(new Date(), spreadsheet.getSpreadsheetTimeZone()));
      properties.setProperty('ACTIVE_SHEET_ID', String(sheet.getSheetId()));
    }
    const triggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === 'cerrarMesAutomatico_';
    });
    if (triggers.length === 0) {
      ScriptApp.newTrigger('cerrarMesAutomatico_').timeBased()
        .onMonthDay(1).atHour(1).inTimezone(spreadsheet.getSpreadsheetTimeZone()).create();
    }
    triggers.slice(1).forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
    properties.setProperty('MONTHLY_ENABLED', 'true');
    closeMonthlyPeriod_(spreadsheet, properties, new Date());
    const message = 'Respaldo mensual activado. Carpeta privada: ' + folder.getUrl();
    console.log(message);
    return message;
  } finally {
    lock.releaseLock();
  }
}

/** Private trigger handler. Uses exactly the same lock as public registrations. */
function cerrarMesAutomatico_() {
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty('MONTHLY_ENABLED') !== 'true') return;
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const spreadsheetId = properties.getProperty('SPREADSHEET_ID');
    if (!spreadsheetId) throw new Error('Ejecuta configurarPlanilla antes de cerrar el mes.');
    closeMonthlyPeriod_(SpreadsheetApp.openById(spreadsheetId), properties, new Date());
  } finally {
    lock.releaseLock();
  }
}

/** Caller must own the script lock. Original records are always retained. */
function closeMonthlyPeriod_(spreadsheet, properties, now) {
  if (properties.getProperty('MONTHLY_ENABLED') !== 'true') return;
  const targetMonth = monthKey_(now, spreadsheet.getSpreadsheetTimeZone());
  let pending = readPending_(properties);
  if (!pending) {
    const month = properties.getProperty('ACTIVE_MONTH');
    const sheetId = properties.getProperty('ACTIVE_SHEET_ID');
    if (!/^\d{4}-\d{2}$/.test(month || '') || sheetId === null || !/^\d+$/.test(sheetId)) {
      throw new Error('La configuración mensual está incompleta. Ejecuta configurarRespaldoMensual desde el editor.');
    }
    const active = spreadsheet.getSheetById(Number(sheetId));
    if (!active || active.getName() !== SHEET_NAME_) {
      throw new Error('No se encuentra la hoja activa del registro. No se modificaron los datos.');
    }
    assertHeaders_(active);
    if (month === targetMonth) return;
    if (month > targetMonth) throw new Error('La fecha actual es anterior al mes activo. Revisa la zona horaria de la planilla.');
    pending = { month: month, sourceSheetId: Number(sheetId), targetMonth: targetMonth, backupId: null };
    savePending_(properties, pending);
  }

  finishMonthlyClose_(spreadsheet, properties, pending);
  // A failed closure may be resumed months later. First finish its exact state,
  // then rotate its new active month again if the calendar has advanced further.
  if (properties.getProperty('ACTIVE_MONTH') !== targetMonth) {
    closeMonthlyPeriod_(spreadsheet, properties, now);
  }
}

function finishMonthlyClose_(spreadsheet, properties, pending) {
  const source = spreadsheet.getSheetById(pending.sourceSheetId);
  assertHeaders_(source);
  const historyName = 'Registros_' + pending.month;
  const namedHistory = spreadsheet.getSheetByName(historyName);
  if (namedHistory && namedHistory.getSheetId() !== source.getSheetId()) {
    throw new Error('Ya existe una hoja llamada ' + historyName + '. No se reemplazó ningún registro.');
  }
  if (source.getName() !== SHEET_NAME_ && source.getName() !== historyName) {
    throw new Error('La hoja del cierre cambió de nombre. Revisa el cierre pendiente antes de continuar.');
  }
  const folderId = properties.getProperty('BACKUP_FOLDER_ID');
  if (!folderId) throw new Error('No se encuentra la carpeta de respaldos. Ejecuta configurarRespaldoMensual.');
  const folder = DriveApp.getFolderById(folderId);
  assertPrivateFolder_(folder);
  const backupName = 'Retiros del almacén - ' + pending.month;
  let backup;
  if (pending.backupId) {
    backup = SpreadsheetApp.openById(pending.backupId);
  } else {
    if (folder.getFilesByName(backupName).hasNext()) {
      throw new Error('Ya existe un archivo de respaldo para ' + pending.month + '. No se reemplazó; revisa la carpeta de respaldos.');
    }
    backup = SpreadsheetApp.create(backupName);
    pending.backupId = backup.getId();
    savePending_(properties, pending);
  }
  const file = DriveApp.getFileById(pending.backupId);
  if (file.getSharingAccess() !== DriveApp.Access.PRIVATE) {
    throw new Error('El archivo del respaldo debe ser privado. No se modificaron los registros.');
  }
  file.moveTo(folder);
  backup.setSpreadsheetTimeZone(spreadsheet.getSpreadsheetTimeZone());

  let copied = pending.backupSheetId === undefined ? null : backup.getSheetById(pending.backupSheetId);
  if (!copied) {
    const candidates = backup.getSheets().filter(function (sheet) { return sheet.getLastRow() > 0; });
    if (candidates.length > 1) throw new Error('El respaldo contiene hojas inesperadas. No se modificaron los registros originales.');
    copied = candidates.length === 1 ? candidates[0] : source.copyTo(backup);
    pending.backupSheetId = copied.getSheetId();
    savePending_(properties, pending);
  }
  copied.setName(SHEET_NAME_);
  SpreadsheetApp.flush();
  verifyCopy_(source, copied);

  if (source.getName() !== historyName) source.setName(historyName);
  pending.sourceRenamed = true;
  savePending_(properties, pending);

  let active = pending.newSheetId === undefined ? null : spreadsheet.getSheetById(pending.newSheetId);
  if (!active) {
    active = spreadsheet.getSheetByName(SHEET_NAME_);
    if (active && (active.getSheetId() === source.getSheetId() || active.getLastRow() > 1)) {
      throw new Error('Ya existe otra hoja Registros con datos. No se reemplazó ningún registro.');
    }
    // The empty sheet may remain after a previous insert succeeded but its
    // following property write failed. It is safe to finish initializing it.
    if (!active) active = spreadsheet.insertSheet(SHEET_NAME_);
    pending.newSheetId = active.getSheetId();
    savePending_(properties, pending);
  }
  if (active.getName() !== SHEET_NAME_ || active.getSheetId() === source.getSheetId()) {
    throw new Error('La nueva hoja activa no coincide con el cierre pendiente. No se modificaron los registros.');
  }
  prepareSheet_(active);
  SpreadsheetApp.flush();
  properties.setProperty('ACTIVE_SHEET_ID', String(active.getSheetId()));
  properties.setProperty('ACTIVE_MONTH', pending.targetMonth);
  properties.deleteProperty('MONTHLY_PENDING');
}

function findWithdrawal_(spreadsheet, properties, active, data) {
  const sheets = [active];
  if (properties.getProperty('MONTHLY_ENABLED') === 'true') {
    spreadsheet.getSheets().forEach(function (sheet) {
      if (/^Registros_\d{4}-\d{2}$/.test(sheet.getName())) sheets.push(sheet);
    });
  }
  for (let index = 0; index < sheets.length; index++) {
    const sheet = sheets[index];
    const count = sheet.getLastRow() - 1;
    if (count <= 0) continue;
    const existing = sheet.getRange(2, 4, count, 1)
      .createTextFinder(data.requestId).matchEntireCell(true).findNext();
    if (existing) {
      const values = sheet.getRange(existing.getRow(), 1, 1, 3).getValues()[0];
      if (values[0] !== data.name || values[1] !== data.item) {
        throw new Error('Este envío ya se registró con otros datos. Recarga la página para registrar un retiro nuevo.');
      }
      return values;
    }
  }
  return null;
}

function prepareSheet_(sheet) {
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS_);
  assertHeaders_(sheet);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 320);
  sheet.setColumnWidth(3, 190);
  sheet.hideColumns(4);
}

function ensureRowCapacity_(sheet, row) {
  const maximum = sheet.getMaxRows();
  if (row > maximum) sheet.insertRowsAfter(maximum, Math.max(100, row - maximum));
}

function assertPrivateFolder_(folder) {
  if (folder.getSharingAccess() !== DriveApp.Access.PRIVATE) {
    throw new Error('La carpeta de respaldos debe ser privada. No se cambiaron sus permisos.');
  }
}

function monthKey_(date, timezone) {
  return Utilities.formatDate(date, timezone, 'yyyy-MM');
}

function savePending_(properties, pending) {
  properties.setProperty('MONTHLY_PENDING', JSON.stringify(pending));
}

function readPending_(properties) {
  const raw = properties.getProperty('MONTHLY_PENDING');
  if (!raw) return null;
  let pending;
  try { pending = JSON.parse(raw); } catch (error) {
    throw new Error('El estado del cierre mensual no es válido. Revisa MONTHLY_PENDING sin borrar las hojas.');
  }
  if (!pending || !/^\d{4}-\d{2}$/.test(pending.month || '') ||
      !/^\d{4}-\d{2}$/.test(pending.targetMonth || '') ||
      typeof pending.sourceSheetId !== 'number' || !Number.isInteger(pending.sourceSheetId) || pending.sourceSheetId < 0 ||
      pending.targetMonth <= pending.month) {
    throw new Error('El estado del cierre mensual no es válido. No se modificaron los datos.');
  }
  return pending;
}

function verifyCopy_(source, copied) {
  assertHeaders_(copied);
  const count = source.getLastRow();
  if (copied.getLastRow() !== count ||
      canonicalRows_(source.getRange(1, 1, count, 4).getValues()) !==
      canonicalRows_(copied.getRange(1, 1, count, 4).getValues())) {
    throw new Error('No se pudo verificar el respaldo. Los registros originales siguen intactos; vuelve a intentarlo.');
  }
}

function canonicalRows_(rows) {
  return JSON.stringify(rows.map(function (row) {
    return row.map(function (value) {
      return Object.prototype.toString.call(value) === '[object Date]'
        ? { type: 'date', value: value.getTime() }
        : { type: typeof value, value: value };
    });
  }));
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
