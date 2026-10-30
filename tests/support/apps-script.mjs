import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const HEADERS = ['Nombre', 'Objeto retirado', 'Fecha y hora', 'ID de registro'];
const source = readFileSync(new URL('../../Code.gs', import.meta.url), 'utf8');

/** In-memory Apps Script services for tests and the explicitly local preview. */
export function createRuntime(options = {}) {
  const rows = (options.initialRows ?? [HEADERS]).map(row => Array.from(row));
  const properties = new Map(options.configured === false ? [] : [['SPREADSHEET_ID', 'sheet-local-test']]);
  const state = {
    sheetExists: options.sheetExists ?? true,
    lockAvailable: options.lockAvailable ?? true,
    lockHeld: false,
    failAppend: options.failAppend ?? false,
    failFlush: options.failFlush ?? false,
    releaseCount: 0,
    appendCount: 0,
    flushCount: 0,
    frozenRows: 0,
    hiddenColumns: [],
    formats: [],
    rawWrites: [],
    formulas: [],
    formatCalls: [],
  };
  const getNow = () => new Date(typeof options.now === 'function'
    ? options.now()
    : options.now ?? '2026-10-30T18:42:00.000Z');
  class RuntimeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [getNow().getTime()]));
    }
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
  function range(row, column, height = 1, width = 1) {
    return {
      getRow: () => row,
      getValue: () => rows[row - 1]?.[column - 1] ?? '',
      getValues: () => Array.from({ length: height }, (_, r) =>
        Array.from({ length: width }, (_, c) => rows[row + r - 1]?.[column + c - 1] ?? '')),
      setValues(values) {
        for (let r = 0; r < height; r++) {
          rows[row + r - 1] ??= [];
          for (let c = 0; c < width; c++) {
            rows[row + r - 1][column + c - 1] = parseCell(values[r][c], row + r, column + c);
          }
        }
        return this;
      },
      setNumberFormat(format) {
        state.formats.push({ row, column, height, width, format });
        return this;
      },
      setFontWeight() { return this; },
      createTextFinder(query) {
        let entireCell = false;
        return {
          matchEntireCell(value) { entireCell = value; return this; },
          useRegularExpression() { return this; },
          findNext() {
            for (let r = 0; r < height; r++) {
              for (let c = 0; c < width; c++) {
                const value = String(rows[row + r - 1]?.[column + c - 1] ?? '');
                if (entireCell ? value === query : value.includes(query)) return range(row + r, column + c);
              }
            }
            return null;
          },
        };
      },
    };
  }
  const sheet = {
    getLastRow: () => rows.length,
    getRange: range,
    appendRow(values) {
      if (state.failAppend) throw new Error('No se pudo escribir en la planilla.');
      state.rawWrites.push(Array.from(values));
      rows.push(Array.from(values, (value, column) => parseCell(value, rows.length + 1, column + 1)));
      state.appendCount++;
      return this;
    },
    setFrozenRows(count) { state.frozenRows = count; return this; },
    setColumnWidth() { return this; },
    hideColumns(column) { state.hiddenColumns.push(column); return this; },
  };
  const spreadsheet = {
    getId: () => 'sheet-local-test',
    getSpreadsheetTimeZone: () => options.timezone ?? 'America/Santiago',
    getSheetByName: name => state.sheetExists && name === 'Registros' ? sheet : null,
    insertSheet(name) {
      if (name !== 'Registros' || state.sheetExists) throw new Error('Hoja inesperada.');
      state.sheetExists = true;
      return sheet;
    },
  };
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
    releaseLock() {
      state.lockHeld = false;
      state.releaseCount++;
    },
  };
  const html = {
    file: null,
    title: null,
    meta: [],
    setTitle(value) { this.title = value; return this; },
    addMetaTag(name, value) { this.meta.push([name, value]); return this; },
  };
  const context = vm.createContext({
    Date: RuntimeDate,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => options.hasActiveSpreadsheet === false ? null : spreadsheet,
      openById(id) {
        if (id !== 'sheet-local-test') throw new Error('Planilla desconocida.');
        return spreadsheet;
      },
      flush() {
        state.flushCount++;
        if (state.failFlush) throw new Error('No se pudo confirmar la escritura.');
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => properties.get(key) ?? null,
        setProperty(key, value) { properties.set(key, value); return this; },
      }),
    },
    LockService: { getScriptLock: () => lock },
    HtmlService: {
      createHtmlOutputFromFile(file) { html.file = file; return html; },
    },
    Utilities: {
      formatDate(date, timezone, pattern) {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('Fecha no válida.');
        if (pattern !== 'dd/MM/yyyy HH:mm:ss') throw new Error('Formato de fecha inesperado.');
        state.formatCalls.push({ date, timezone, pattern });
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: timezone,
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        }).formatToParts(date);
        const part = type => parts.find(item => item.type === type).value;
        return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}:${part('second')}`;
      },
    },
  });
  vm.runInContext(source, context, { filename: 'Code.gs' });
  return { context, rows, state, properties, sheet, spreadsheet, html };
}
