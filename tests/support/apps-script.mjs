import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const HEADERS = ['Nombre', 'Objeto retirado', 'Fecha y hora', 'ID de registro'];
const source = readFileSync(new URL('../../Code.gs', import.meta.url), 'utf8');
const cloneRows = rows => rows.map(row => Array.from(row, value => value instanceof Date ? new Date(value.getTime()) : value));
const iterator = values => {
  let index = 0;
  return { hasNext: () => index < values.length, next: () => values[index++] };
};

/** In-memory Apps Script services for tests and the explicitly local preview. */
export function createRuntime(options = {}) {
  const rows = cloneRows(options.initialRows ?? [HEADERS]);
  const properties = new Map(options.configured === false ? [] : [['SPREADSHEET_ID', 'sheet-local-test']]);
  for (const [key, value] of Object.entries(options.properties ?? {})) properties.set(key, value);
  const state = {
    sheetExists: options.sheetExists ?? true,
    lockAvailable: options.lockAvailable ?? true,
    lockHeld: false,
    failAppend: options.failAppend ?? false,
    failFlush: options.failFlush ?? false,
    failCopy: false, corruptCopy: false, failMove: false, failRename: false,
    failArchiveRename: false, failInsertSheet: false, failCreateSpreadsheet: false,
    failCreateFolder: false, failTrigger: false,
    releaseCount: 0, appendCount: 0, flushCount: 0, frozenRows: 0,
    hiddenColumns: [], formats: [], rawWrites: [], formulas: [], formatCalls: [],
    driveCalls: [], copyCount: 0, createSpreadsheetCount: 0, folderCreateCount: 0,
    moveCount: 0, renameCount: 0, rowGrowth: [], deletedSheets: [],
    triggers: [], triggerDeletes: [], propertyWrites: [],
  };
  const spreadsheets = new Map();
  const folders = new Map();
  const files = new Map();
  let nextSheetId = 0;
  let nextSpreadsheetId = 0;
  let nextFolderId = 0;
  const getNow = () => new Date(typeof options.now === 'function'
    ? options.now()
    : options.now ?? '2026-10-30T18:42:00.000Z');
  class RuntimeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [getNow().getTime()])); }
    static now() { return getNow().getTime(); }
  }

  // Sheets consumes one leading apostrophe as a text escape, including when
  // the cell has plain-text formatting. Preserve this behavior for dedup tests.
  function parseCell(value, row, column) {
    if (typeof value !== 'string') return value;
    if (value.startsWith("'")) return value.slice(1);
    if (value.startsWith('=')) state.formulas.push({ row, column, value });
    return value;
  }
  function createSheet(parent, name, data = [], maximumRows = 1000) {
    let sheetName = name;
    let maxRows = Math.max(maximumRows, data.length);
    const sheetId = ++nextSheetId;
    const sheet = {
      rows: data,
      getSheetId: () => sheetId,
      getName: () => sheetName,
      getParent: () => parent,
      getLastRow: () => data.length,
      getLastColumn: () => Math.max(0, ...data.map(row => row.length)),
      getMaxRows: () => maxRows,
      getMaxColumns: () => 26,
      insertRowsAfter(after, count) {
        if (after < 1 || after > maxRows || count < 1) throw new Error('Ampliación de filas no válida.');
        state.rowGrowth.push({ sheetId, after, count });
        maxRows += count;
        return this;
      },
      setName(value) {
        if (state.failRename || (state.failArchiveRename && parent.getId() === 'sheet-local-test' && value.startsWith('Registros_'))) {
          throw new Error('No se pudo renombrar la hoja.');
        }
        if (parent.getSheets().some(other => other !== this && other.getName() === value)) throw new Error('Ya existe una hoja con ese nombre.');
        sheetName = value;
        state.renameCount++;
        if (parent.getId() === 'sheet-local-test') state.sheetExists = !!parent.getSheetByName('Registros');
        return this;
      },
      copyTo(destination) {
        if (state.failCopy) throw new Error('No se pudo copiar la hoja.');
        const copied = cloneRows(data);
        if (state.corruptCopy && copied.length > 0) {
          // Keep valid headers when there are records, so verification must
          // compare the copied data rather than just the sheet structure.
          if (copied.length > 1) copied[1][1] = 'Copia incompleta';
          else copied[0][0] = 'Copia incompleta';
        }
        const target = destination._addSheet(`Copia de ${sheetName}`, copied, maxRows);
        state.copyCount++;
        return target;
      },
      getRange: range,
      getDataRange: () => range(1, 1, Math.max(1, data.length), Math.max(1, sheet.getLastColumn())),
      appendRow(values) {
        if (state.failAppend) throw new Error('No se pudo escribir en la planilla.');
        if (data.length >= maxRows) maxRows++;
        state.rawWrites.push(Array.from(values));
        data.push(Array.from(values, (value, column) => parseCell(value, data.length + 1, column + 1)));
        state.appendCount++;
        return this;
      },
      setFrozenRows(count) { state.frozenRows = count; return this; },
      setColumnWidth() { return this; },
      hideColumns(column) { state.hiddenColumns.push(column); return this; },
    };
    function range(row, column, height = 1, width = 1) {
      if (row < 1 || column < 1 || height < 1 || width < 1 || row + height - 1 > maxRows) throw new Error('El rango excede las filas de la hoja.');
      return {
        getRow: () => row,
        getValue: () => data[row - 1]?.[column - 1] ?? '',
        getValues: () => Array.from({ length: height }, (_, r) =>
          Array.from({ length: width }, (_, c) => data[row + r - 1]?.[column + c - 1] ?? '')),
        setValues(values) {
          for (let r = 0; r < height; r++) {
            data[row + r - 1] ??= [];
            for (let c = 0; c < width; c++) data[row + r - 1][column + c - 1] = parseCell(values[r][c], row + r, column + c);
          }
          return this;
        },
        setNumberFormat(format) { state.formats.push({ row, column, height, width, format }); return this; },
        setFontWeight() { return this; },
        createTextFinder(query) {
          let entireCell = false;
          return {
            matchEntireCell(value) { entireCell = value; return this; },
            useRegularExpression() { return this; },
            findNext() {
              for (let r = 0; r < height; r++) {
                for (let c = 0; c < width; c++) {
                  const value = String(data[row + r - 1]?.[column + c - 1] ?? '');
                  if (entireCell ? value === query : value.includes(query)) return range(row + r, column + c);
                }
              }
              return null;
            },
          };
        },
      };
    }
    return sheet;
  }

  function createSpreadsheet(id, name, initial = []) {
    const sheets = [];
    let timezone = options.timezone ?? 'America/Santiago';
    const spreadsheet = {
      getId: () => id,
      getName: () => name,
      getSpreadsheetTimeZone: () => timezone,
      setSpreadsheetTimeZone(value) { timezone = value; return this; },
      getSheets: () => [...sheets],
      getSheetById: value => sheets.find(sheet => String(sheet.getSheetId()) === String(value)) ?? null,
      getSheetByName: value => sheets.find(sheet => sheet.getName() === value) ?? null,
      _attachSheet(value) { sheets.push(value); },
      _addSheet(value, data = [], maxRows) {
        if (this.getSheetByName(value)) throw new Error('Ya existe una hoja con ese nombre.');
        const created = createSheet(this, value, data, maxRows);
        sheets.push(created);
        return created;
      },
      insertSheet(value) {
        if (state.failInsertSheet) throw new Error('No se pudo crear la hoja.');
        if (id === 'sheet-local-test' && value === 'Registros' && !sheets.includes(sheet)) {
          sheets.push(sheet);
          state.sheetExists = true;
          return sheet;
        }
        const created = this._addSheet(value);
        if (id === 'sheet-local-test' && value === 'Registros') state.sheetExists = true;
        return created;
      },
      deleteSheet(value) {
        const index = sheets.indexOf(value);
        if (index === -1) throw new Error('Hoja no encontrada.');
        state.deletedSheets.push({ spreadsheetId: id, sheetId: value.getSheetId(), name: value.getName() });
        sheets.splice(index, 1);
      },
    };
    spreadsheets.set(id, spreadsheet);
    files.set(id, {
      folderId: null,
      sharing: options.fileSharing ?? 'PRIVATE',
      getId: () => id,
      getName: () => name,
      getSharingAccess() { return this.sharing; },
      getParents() { return iterator(this.folderId ? [folders.get(this.folderId)] : []); },
      moveTo(folder) {
        state.driveCalls.push('moveTo');
        if (state.failMove) throw new Error('No se pudo mover el respaldo.');
        this.folderId = folder.getId();
        state.moveCount++;
        return this;
      },
    });
    for (const entry of initial) spreadsheet._addSheet(entry.name, cloneRows(entry.rows), entry.maxRows);
    return spreadsheet;
  }

  const spreadsheet = createSpreadsheet('sheet-local-test', 'Almacén');
  const sheet = createSheet(spreadsheet, 'Registros', rows, options.maxRows ?? 1000);
  // Keep the initial sheet and runtime.rows identity used by the original tests.
  if (state.sheetExists) spreadsheet._attachSheet(sheet);
  for (const entry of options.additionalSheets ?? []) spreadsheet._addSheet(entry.name, cloneRows(entry.rows), entry.maxRows);

  const lock = {
    waitLock() {
      if (!state.lockAvailable || state.lockHeld) throw new Error('Tiempo de espera del bloqueo agotado.');
      state.lockHeld = true;
    },
    tryLock() {
      if (!state.lockAvailable || state.lockHeld) return false;
      state.lockHeld = true;
      return true;
    },
    releaseLock() { state.lockHeld = false; state.releaseCount++; },
  };
  const html = {
    file: null, title: null, meta: [],
    setTitle(value) { this.title = value; return this; },
    addMetaTag(name, value) { this.meta.push([name, value]); return this; },
  };
  const context = vm.createContext({
    Date: RuntimeDate,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => options.hasActiveSpreadsheet === false ? null : options.activeSpreadsheetId
        ? spreadsheets.get(options.activeSpreadsheetId) ?? { getId: () => options.activeSpreadsheetId }
        : spreadsheet,
      openById(id) {
        if (!spreadsheets.has(id)) throw new Error('Planilla desconocida.');
        return spreadsheets.get(id);
      },
      create(name) {
        if (state.failCreateSpreadsheet) throw new Error('No se pudo crear la planilla de respaldo.');
        state.createSpreadsheetCount++;
        return createSpreadsheet(`backup-${++nextSpreadsheetId}`, name, [{ name: 'Hoja 1', rows: [] }]);
      },
      flush() {
        state.flushCount++;
        if (state.failFlush) throw new Error('No se pudo confirmar la escritura.');
      },
    },
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE', ANYONE: 'ANYONE' },
      createFolder(name) {
        state.driveCalls.push('createFolder');
        if (state.failCreateFolder) throw new Error('No se pudo crear la carpeta.');
        const id = `folder-${++nextFolderId}`;
        const folder = {
          sharing: options.folderSharing ?? 'PRIVATE',
          getId: () => id, getName: () => name,
          getUrl: () => `https://drive.google.com/drive/folders/${id}`,
          getSharingAccess() { return this.sharing; },
          getFilesByName(value) { return iterator([...files.values()].filter(file => file.folderId === id && file.getName() === value)); },
        };
        folders.set(id, folder);
        state.folderCreateCount++;
        return folder;
      },
      getFolderById(id) {
        state.driveCalls.push('getFolderById');
        if (!folders.has(id)) throw new Error('Carpeta desconocida.');
        return folders.get(id);
      },
      getFileById(id) {
        state.driveCalls.push('getFileById');
        if (!files.has(id)) throw new Error('Archivo desconocido.');
        return files.get(id);
      },
    },
    ScriptApp: {
      getProjectTriggers: () => [...state.triggers],
      deleteTrigger(trigger) {
        state.triggerDeletes.push(trigger);
        state.triggers.splice(state.triggers.indexOf(trigger), 1);
      },
      newTrigger(handler) {
        const schedule = { handler };
        const builder = {
          timeBased() { return this; },
          onMonthDay(day) { schedule.day = day; return this; },
          atHour(hour) { schedule.hour = hour; return this; },
          inTimezone(zone) { schedule.timezone = zone; return this; },
          create() {
            if (state.failTrigger) throw new Error('No se pudo crear el activador.');
            const trigger = { ...schedule, getHandlerFunction: () => handler };
            state.triggers.push(trigger);
            return trigger;
          },
        };
        return builder;
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => properties.get(key) ?? null,
        setProperty(key, value) { properties.set(key, value); state.propertyWrites.push([key, value]); return this; },
        deleteProperty(key) { properties.delete(key); return this; },
        setProperties(values) { for (const [key, value] of Object.entries(values)) this.setProperty(key, value); return this; },
      }),
    },
    LockService: { getScriptLock: () => lock },
    HtmlService: { createHtmlOutputFromFile(file) { html.file = file; return html; } },
    Utilities: {
      formatDate(date, timezone, pattern) {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('Fecha no válida.');
        if (!['dd/MM/yyyy HH:mm:ss', 'yyyy-MM'].includes(pattern)) throw new Error('Formato de fecha inesperado.');
        state.formatCalls.push({ date, timezone, pattern });
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: timezone,
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        }).formatToParts(date);
        const part = type => parts.find(item => item.type === type).value;
        return pattern === 'yyyy-MM' ? `${part('year')}-${part('month')}`
          : `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}:${part('second')}`;
      },
    },
  });
  vm.runInContext(source, context, { filename: 'Code.gs' });
  return { context, rows, state, properties, sheet, spreadsheet, spreadsheets, folders, files, html };
}
