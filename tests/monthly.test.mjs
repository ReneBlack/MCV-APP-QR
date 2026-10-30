import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime, HEADERS } from './support/apps-script.mjs';

const valid = (overrides = {}) => ({
  name: 'Ana Pérez', item: '2 cajas de guantes', requestId: 'monthly-request-0001', ...overrides,
});
const data = sheet => sheet.getRange(1, 1, sheet.getLastRow(), 4).getValues()
  .map(row => row.map(value => value instanceof Date ? new Date(value.getTime()) : value));
const backups = runtime => [...runtime.spreadsheets.values()].filter(sheet => sheet !== runtime.spreadsheet);

function monthlyRuntime(options = {}) {
  let now = options.now ?? '2026-10-30T18:42:00.000Z';
  const runtime = createRuntime({ ...options, now: () => now });
  runtime.setNow = value => { now = value; };
  runtime.context.configurarRespaldoMensual();
  return runtime;
}

function nextMonth(runtime) {
  runtime.setNow('2026-11-01T05:00:00.000Z');
}

test('la instalación mensual exige el editor de la misma planilla configurada', async t => {
  for (const [name, options] of [
    ['web app sin planilla activa', { hasActiveSpreadsheet: false }],
    ['planilla sin configuración inicial', { configured: false }],
    ['otra planilla activa', { activeSpreadsheetId: 'another-sheet' }],
  ]) {
    await t.test(name, () => {
      const runtime = createRuntime(options);
      assert.throws(() => runtime.context.configurarRespaldoMensual());
      assert.equal(runtime.properties.has('MONTHLY_ENABLED'), false);
      assert.equal(runtime.state.triggers.length, 0);
      assert.equal(runtime.state.folderCreateCount, 0);
      assert.equal(runtime.state.createSpreadsheetCount, 0);
      assert.deepEqual(runtime.rows, [HEADERS]);
    });
  }
});

test('instala una carpeta privada y un único activador mensual en la zona de la planilla', () => {
  const runtime = monthlyRuntime();
  const folderId = runtime.properties.get('BACKUP_FOLDER_ID');
  const folder = runtime.folders.get(folderId);
  assert.equal(folder.getName(), 'Respaldos del almacén');
  assert.equal(folder.getSharingAccess(), 'PRIVATE');
  assert.equal(runtime.properties.get('MONTHLY_ENABLED'), 'true');
  assert.equal(runtime.properties.get('ACTIVE_MONTH'), '2026-10');
  assert.equal(String(runtime.properties.get('ACTIVE_SHEET_ID')), String(runtime.sheet.getSheetId()));
  assert.equal(runtime.state.triggers.length, 1);
  assert.deepEqual({ ...runtime.state.triggers[0], getHandlerFunction: undefined }, {
    handler: 'cerrarMesAutomatico_', day: 1, hour: 1, timezone: 'America/Santiago', getHandlerFunction: undefined,
  });
  runtime.context.configurarRespaldoMensual();
  assert.equal(runtime.state.folderCreateCount, 1);
  assert.equal(runtime.properties.get('BACKUP_FOLDER_ID'), folderId);
  assert.equal(runtime.state.triggers.filter(trigger => trigger.getHandlerFunction() === 'cerrarMesAutomatico_').length, 1);
  assert.equal(runtime.state.lockHeld, false);
});

test('reinstalar preserva los activadores ajenos y los registros existentes', () => {
  const runtime = monthlyRuntime();
  runtime.context.registerWithdrawal(valid());
  const snapshot = data(runtime.sheet);
  const unrelated = { getHandlerFunction: () => 'otraFuncion' };
  runtime.state.triggers.push(unrelated, { getHandlerFunction: () => 'cerrarMesAutomatico_' });
  runtime.context.configurarRespaldoMensual();
  assert.equal(runtime.state.triggers.includes(unrelated), true);
  assert.equal(runtime.state.triggers.filter(trigger => trigger.getHandlerFunction() === 'cerrarMesAutomatico_').length, 1);
  assert.deepEqual(data(runtime.sheet), snapshot);
});

test('sin activar el respaldo mensual no usa Drive ni crea copias', () => {
  const runtime = createRuntime();
  runtime.context.cerrarMesAutomatico_();
  runtime.context.registerWithdrawal(valid());
  assert.equal(runtime.rows.length, 2);
  assert.equal(runtime.state.driveCalls.length, 0);
  assert.equal(runtime.state.createSpreadsheetCount, 0);
});

test('el mismo mes no crea archivos ni rota la hoja', () => {
  const runtime = monthlyRuntime();
  runtime.context.registerWithdrawal(valid());
  runtime.context.cerrarMesAutomatico_();
  assert.equal(runtime.state.createSpreadsheetCount, 0);
  assert.equal(runtime.spreadsheet.getSheetByName('Registros'), runtime.sheet);
  assert.equal(runtime.properties.has('MONTHLY_PENDING'), false);
});

test('copia y verifica el mes cerrado; conserva el original y abre una hoja nueva vacía', () => {
  const runtime = monthlyRuntime();
  runtime.context.registerWithdrawal(valid({ name: "'Ana", item: '=2+2' }));
  const original = data(runtime.sheet);
  nextMonth(runtime);
  runtime.context.cerrarMesAutomatico_();

  assert.equal(backups(runtime).length, 1);
  const backup = backups(runtime)[0];
  assert.equal(backup.getName(), 'Retiros del almacén - 2026-10');
  assert.equal(backup.getSpreadsheetTimeZone(), 'America/Santiago');
  assert.deepEqual(data(backup.getSheetByName('Registros')), original);
  assert.equal(backup.getSheets().filter(sheet => sheet.getLastRow() > 0).length, 1);
  assert.equal(runtime.files.get(backup.getId()).folderId, runtime.properties.get('BACKUP_FOLDER_ID'));
  assert.equal(runtime.files.get(backup.getId()).getSharingAccess(), 'PRIVATE');
  assert.equal(runtime.spreadsheet.getSheetByName('Registros_2026-10'), runtime.sheet);
  assert.deepEqual(data(runtime.sheet), original);
  assert.deepEqual(data(runtime.spreadsheet.getSheetByName('Registros')), [HEADERS]);
  assert.equal(runtime.properties.get('ACTIVE_MONTH'), '2026-11');
  assert.equal(String(runtime.properties.get('ACTIVE_SHEET_ID')), String(runtime.spreadsheet.getSheetByName('Registros').getSheetId()));
  assert.equal(runtime.properties.has('MONTHLY_PENDING'), false);
  assert.deepEqual(runtime.state.deletedSheets, []);
  assert.equal(runtime.state.lockHeld, false);

  runtime.context.cerrarMesAutomatico_();
  assert.equal(runtime.state.createSpreadsheetCount, 1);
  assert.equal(runtime.state.copyCount, 1);
});

test('el primer retiro del mes cierra el anterior bajo el mismo bloqueo y registra en la hoja nueva', () => {
  const runtime = monthlyRuntime();
  runtime.context.registerWithdrawal(valid());
  const original = data(runtime.sheet);
  const releases = runtime.state.releaseCount;
  nextMonth(runtime);
  const result = runtime.context.registerWithdrawal(valid({ requestId: 'monthly-request-0002', item: '1 llave' }));
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(runtime.state.releaseCount, releases + 1);
  assert.equal(runtime.state.lockHeld, false);
  assert.deepEqual(data(runtime.sheet), original);
  const current = runtime.spreadsheet.getSheetByName('Registros');
  assert.equal(current.getLastRow(), 2);
  assert.equal(data(current)[1][1], '1 llave');
  assert.equal(data(current)[1][2].toISOString(), '2026-11-01T05:00:00.000Z');
  assert.equal(runtime.state.copyCount, 1);
});

test('los reintentos encuentran los IDs en el historial sin duplicar ni cambiar su fecha', () => {
  const runtime = monthlyRuntime();
  const original = runtime.context.registerWithdrawal(valid());
  nextMonth(runtime);
  runtime.context.cerrarMesAutomatico_();
  const result = runtime.context.registerWithdrawal(valid());
  assert.equal(result.duplicate, true);
  assert.equal(result.registeredAt, original.registeredAt);
  assert.deepEqual(data(runtime.spreadsheet.getSheetByName('Registros')), [HEADERS]);
  assert.equal(runtime.sheet.getLastRow(), 2);
  assert.throws(() => runtime.context.registerWithdrawal(valid({ item: 'Objeto distinto' })), /otros datos/);
});

test('el cambio de año sigue el mes local y no el mes UTC', () => {
  const runtime = monthlyRuntime({ now: '2026-12-31T23:00:00Z', timezone: 'America/Santiago' });
  runtime.context.registerWithdrawal(valid());
  runtime.setNow('2027-01-01T01:00:00Z');
  runtime.context.cerrarMesAutomatico_();
  assert.equal(runtime.state.copyCount, 0, 'En Chile todavía es diciembre');
  assert.equal(runtime.properties.get('ACTIVE_MONTH'), '2026-12');
  runtime.setNow('2027-01-01T04:00:00Z');
  runtime.context.cerrarMesAutomatico_();
  assert.equal(runtime.properties.get('ACTIVE_MONTH'), '2027-01');
  assert.equal(runtime.spreadsheet.getSheetByName('Registros_2026-12'), runtime.sheet);
  assert.equal(backups(runtime)[0].getName(), 'Retiros del almacén - 2026-12');
});

test('el cierre recupera fallos de copia, movimiento y renombre sin duplicar el archivo', async t => {
  for (const flag of ['failCopy', 'failMove', 'failRename', 'failArchiveRename']) {
    await t.test(flag, () => {
      const runtime = monthlyRuntime();
      runtime.context.registerWithdrawal(valid());
      const original = data(runtime.sheet);
      nextMonth(runtime);
      runtime.state[flag] = true;
      assert.throws(() => runtime.context.cerrarMesAutomatico_());
      assert.deepEqual(data(runtime.sheet), original);
      assert.equal(runtime.spreadsheet.getSheetByName('Registros'), runtime.sheet);
      assert.equal(runtime.properties.get('ACTIVE_MONTH'), '2026-10');
      assert.equal(runtime.state.lockHeld, false);
      const pending = JSON.parse(runtime.properties.get('MONTHLY_PENDING'));
      assert.equal(pending.month, '2026-10');
      assert.equal(pending.sourceSheetId, runtime.sheet.getSheetId());
      assert.ok(pending.backupId);

      runtime.state[flag] = false;
      runtime.context.cerrarMesAutomatico_();
      assert.equal(runtime.state.createSpreadsheetCount, 1);
      assert.equal(runtime.state.copyCount, 1);
      assert.equal(runtime.properties.has('MONTHLY_PENDING'), false);
      assert.deepEqual(data(runtime.sheet), original);
      assert.equal(runtime.spreadsheet.getSheetByName('Registros_2026-10'), runtime.sheet);
      assert.deepEqual(data(runtime.spreadsheet.getSheetByName('Registros')), [HEADERS]);
      assert.deepEqual(runtime.state.deletedSheets, []);
    });
  }
});

test('recupera un cierre interrumpido después de renombrar y antes de crear Registros', () => {
  const runtime = monthlyRuntime();
  runtime.context.registerWithdrawal(valid());
  const original = data(runtime.sheet);
  nextMonth(runtime);
  runtime.state.failInsertSheet = true;
  assert.throws(() => runtime.context.cerrarMesAutomatico_());
  assert.equal(runtime.spreadsheet.getSheetByName('Registros'), null);
  assert.equal(runtime.spreadsheet.getSheetByName('Registros_2026-10'), runtime.sheet);
  assert.deepEqual(data(runtime.sheet), original);
  assert.ok(runtime.properties.get('MONTHLY_PENDING'));
  assert.equal(runtime.state.createSpreadsheetCount, 1);
  assert.equal(runtime.state.copyCount, 1);
  assert.equal(runtime.state.lockHeld, false);

  runtime.state.failInsertSheet = false;
  const result = runtime.context.registerWithdrawal(valid({ requestId: 'monthly-request-0002', item: '1 llave' }));
  assert.equal(result.ok, true);
  assert.equal(runtime.state.createSpreadsheetCount, 1);
  assert.equal(runtime.state.copyCount, 1);
  assert.equal(runtime.properties.get('ACTIVE_MONTH'), '2026-11');
  assert.equal(runtime.properties.has('MONTHLY_PENDING'), false);
  assert.equal(runtime.spreadsheet.getSheetByName('Registros').getLastRow(), 2);
  assert.deepEqual(data(runtime.sheet), original);
  assert.deepEqual(runtime.state.deletedSheets, []);
});

test('una copia corrupta impide rotar el original y no confirma registros nuevos', () => {
  const runtime = monthlyRuntime();
  runtime.context.registerWithdrawal(valid());
  const original = data(runtime.sheet);
  nextMonth(runtime);
  runtime.state.corruptCopy = true;
  assert.throws(() => runtime.context.registerWithdrawal(valid({ requestId: 'monthly-request-0002' })), /verificar el respaldo/);
  assert.deepEqual(data(runtime.sheet), original);
  assert.equal(runtime.spreadsheet.getSheetByName('Registros'), runtime.sheet);
  assert.equal(runtime.properties.get('ACTIVE_MONTH'), '2026-10');
  assert.equal(runtime.state.lockHeld, false);
  assert.deepEqual(runtime.state.deletedSheets, []);
});

test('un nombre histórico existente bloquea el cierre sin sobrescribir ninguna hoja', () => {
  const runtime = monthlyRuntime({ additionalSheets: [{ name: 'Registros_2026-10', rows: [HEADERS, ['Anterior', 'No borrar', new Date('2026-10-01'), 'historical-0000001']] }] });
  runtime.context.registerWithdrawal(valid());
  const archive = runtime.spreadsheet.getSheetByName('Registros_2026-10');
  const oldArchive = data(archive);
  const original = data(runtime.sheet);
  nextMonth(runtime);
  assert.throws(() => runtime.context.cerrarMesAutomatico_());
  assert.deepEqual(data(archive), oldArchive);
  assert.deepEqual(data(runtime.sheet), original);
  assert.equal(runtime.spreadsheet.getSheetByName('Registros'), runtime.sheet);
  assert.deepEqual(runtime.state.deletedSheets, []);
});

test('un archivo de respaldo del mismo nombre bloquea crear otro sin modificar el original', () => {
  const runtime = monthlyRuntime();
  runtime.context.registerWithdrawal(valid());
  const original = data(runtime.sheet);
  const existing = runtime.context.SpreadsheetApp.create('Retiros del almacén - 2026-10');
  runtime.files.get(existing.getId()).moveTo(runtime.folders.get(runtime.properties.get('BACKUP_FOLDER_ID')));
  const creations = runtime.state.createSpreadsheetCount;
  nextMonth(runtime);
  assert.throws(() => runtime.context.cerrarMesAutomatico_());
  assert.equal(runtime.state.createSpreadsheetCount, creations);
  assert.deepEqual(data(runtime.sheet), original);
  assert.equal(runtime.spreadsheet.getSheetByName('Registros'), runtime.sheet);
});

test('si el bloqueo está ocupado no inicia respaldo ni modifica registros', () => {
  const runtime = monthlyRuntime();
  runtime.context.registerWithdrawal(valid());
  const original = data(runtime.sheet);
  nextMonth(runtime);
  runtime.state.lockAvailable = false;
  assert.throws(() => runtime.context.cerrarMesAutomatico_());
  assert.equal(runtime.state.createSpreadsheetCount, 0);
  assert.deepEqual(data(runtime.sheet), original);
  assert.equal(runtime.properties.has('MONTHLY_PENDING'), false);
});

test('amplía filas antes de dar formato cuando la hoja llegó a su capacidad', () => {
  const runtime = createRuntime({ maxRows: 1 });
  assert.equal(runtime.sheet.getMaxRows(), 1);
  runtime.context.registerWithdrawal(valid());
  assert.equal(runtime.sheet.getLastRow(), 2);
  assert.ok(runtime.sheet.getMaxRows() >= 2);
  assert.equal(runtime.state.rowGrowth.length, 1);
  assert.equal(runtime.state.rowGrowth[0].after, 1);
});

test('un mes sin retiros conserva una copia de encabezados y abre el nuevo período', () => {
  const runtime = monthlyRuntime();
  nextMonth(runtime);
  runtime.context.cerrarMesAutomatico_();
  assert.equal(backups(runtime).length, 1);
  assert.deepEqual(data(backups(runtime)[0].getSheetByName('Registros')), [HEADERS]);
  assert.deepEqual(data(runtime.spreadsheet.getSheetByName('Registros_2026-10')), [HEADERS]);
  assert.deepEqual(data(runtime.spreadsheet.getSheetByName('Registros')), [HEADERS]);
  assert.equal(runtime.properties.get('ACTIVE_MONTH'), '2026-11');
  assert.deepEqual(runtime.state.deletedSheets, []);
});

test('una carpeta compartida impide activar el respaldo y nunca cambia permisos', () => {
  const runtime = createRuntime({ folderSharing: 'ANYONE' });
  assert.throws(() => runtime.context.configurarRespaldoMensual(), /privada/);
  assert.equal(runtime.properties.has('MONTHLY_ENABLED'), false);
  assert.equal(runtime.state.triggers.length, 0);
  assert.equal(runtime.state.createSpreadsheetCount, 0);
  assert.equal([...runtime.folders.values()][0].getSharingAccess(), 'ANYONE');
});

test('si la carpeta deja de ser privada el cierre se detiene antes de copiar', () => {
  const runtime = monthlyRuntime();
  runtime.context.registerWithdrawal(valid());
  const original = data(runtime.sheet);
  runtime.folders.get(runtime.properties.get('BACKUP_FOLDER_ID')).sharing = 'ANYONE';
  nextMonth(runtime);
  assert.throws(() => runtime.context.cerrarMesAutomatico_(), /privada/);
  assert.equal(runtime.state.createSpreadsheetCount, 0);
  assert.deepEqual(data(runtime.sheet), original);
  assert.equal(runtime.spreadsheet.getSheetByName('Registros'), runtime.sheet);
});

test('si falla inicializar la hoja nueva se recupera la misma hoja y el mismo respaldo', () => {
  const runtime = monthlyRuntime();
  runtime.context.registerWithdrawal(valid());
  const original = data(runtime.sheet);
  nextMonth(runtime);
  runtime.state.failAppend = true;
  assert.throws(() => runtime.context.cerrarMesAutomatico_());
  const empty = runtime.spreadsheet.getSheetByName('Registros');
  assert.ok(empty);
  assert.equal(empty.getLastRow(), 0);
  assert.deepEqual(data(runtime.sheet), original);
  runtime.state.failAppend = false;
  runtime.context.cerrarMesAutomatico_();
  assert.equal(runtime.spreadsheet.getSheetByName('Registros'), empty);
  assert.deepEqual(data(empty), [HEADERS]);
  assert.equal(runtime.state.createSpreadsheetCount, 1);
  assert.equal(runtime.state.copyCount, 1);
  assert.equal(runtime.properties.has('MONTHLY_PENDING'), false);
});

test('un cierre pendiente de meses atrás termina sin duplicados y avanza hasta el mes actual', () => {
  const runtime = monthlyRuntime();
  runtime.context.registerWithdrawal(valid());
  const original = data(runtime.sheet);
  nextMonth(runtime);
  runtime.state.failArchiveRename = true;
  assert.throws(() => runtime.context.cerrarMesAutomatico_());
  runtime.state.failArchiveRename = false;
  runtime.setNow('2027-01-02T12:00:00Z');
  runtime.context.cerrarMesAutomatico_();
  assert.equal(runtime.properties.get('ACTIVE_MONTH'), '2027-01');
  assert.equal(runtime.state.createSpreadsheetCount, 2);
  assert.equal(runtime.state.copyCount, 2);
  assert.deepEqual(backups(runtime).map(backup => backup.getName()), [
    'Retiros del almacén - 2026-10', 'Retiros del almacén - 2026-11',
  ]);
  assert.deepEqual(data(runtime.sheet), original);
  assert.deepEqual(data(runtime.spreadsheet.getSheetByName('Registros')), [HEADERS]);
  assert.equal(runtime.properties.has('MONTHLY_PENDING'), false);
  assert.deepEqual(runtime.state.deletedSheets, []);
});
