import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, HEADERS } from './support/apps-script.mjs';

const valid = (overrides = {}) => ({
  name: 'Ana Pérez', item: '2 cajas de guantes', requestId: 'test-request-00000001', ...overrides,
});

test('registra nombre, objeto y fecha del servidor; ignora fechas enviadas por el teléfono', () => {
  const runtime = createRuntime();
  const result = runtime.context.registerWithdrawal(valid({ timestamp: '1999-01-01', registeredAt: 'ayer' }));
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.registeredAt, '30/10/2026 15:42:00');
  assert.deepEqual(runtime.rows[1].slice(0, 2), ['Ana Pérez', '2 cajas de guantes']);
  assert.equal(runtime.rows[1][2].toISOString(), '2026-10-30T18:42:00.000Z');
  assert.equal(runtime.rows[1][3], 'test-request-00000001');
  assert.equal(runtime.state.flushCount, 1);
  assert.equal(runtime.state.releaseCount, 1);
  assert.equal(runtime.state.lockHeld, false);
  assert.ok(runtime.state.formats.some(format => format.column === 1 && format.width === 2 && format.format === '@'));
  assert.ok(runtime.state.formats.some(format => format.column === 3 && format.format === 'dd/MM/yyyy HH:mm:ss'));
});

test('normaliza el nombre y respeta los saltos de línea del detalle', () => {
  const runtime = createRuntime();
  runtime.context.registerWithdrawal(valid({ name: '  Ana  \n Pérez  ', item: '  Guantes\n2 cajas  ' }));
  assert.deepEqual(runtime.rows[1].slice(0, 2), ['Ana Pérez', 'Guantes\n2 cajas']);
});

test('rechaza datos vacíos, tipos incorrectos, límites y solicitudes sin identificador válido', async t => {
  const cases = [
    ['null', null],
    ['sin nombre', valid({ name: '  ' })],
    ['sin objeto', valid({ item: '\n\t ' })],
    ['nombre numérico', valid({ name: 123 })],
    ['objeto como lista', valid({ item: ['guantes'] })],
    ['nombre demasiado largo', valid({ name: 'a'.repeat(101) })],
    ['objeto demasiado largo', valid({ item: 'a'.repeat(501) })],
    ['carácter de control en nombre', valid({ name: 'Ana\u0000Pérez' })],
    ['carácter de control en objeto', valid({ item: 'Guantes\u0007' })],
    ['sin identificador', valid({ requestId: undefined })],
    ['identificador corto', valid({ requestId: 'short' })],
    ['identificador largo', valid({ requestId: 'a'.repeat(81) })],
    ['identificador con fórmula', valid({ requestId: '=1234567890123456' })],
  ];
  for (const [label, payload] of cases) {
    await t.test(label, () => {
      const runtime = createRuntime();
      assert.throws(() => runtime.context.registerWithdrawal(payload));
      assert.equal(runtime.rows.length, 1);
      assert.equal(runtime.state.appendCount, 0);
    });
  }
});

test('acepta exactamente los límites de longitud', () => {
  const runtime = createRuntime();
  assert.equal(runtime.context.registerWithdrawal(valid({ name: 'a'.repeat(100), item: 'b'.repeat(500) })).ok, true);
  assert.equal(runtime.rows[1][0].length, 100);
  assert.equal(runtime.rows[1][1].length, 500);
});

test('guarda texto peligroso sin fórmulas y permite reintentar incluso un apóstrofe inicial', async t => {
  for (const text of ['=IMPORTXML("https://example.invalid","//x")', '+2+2', '-2+2', '@SUM(1)', "'guantes", "'=2+2"]) {
    await t.test(text, () => {
      const runtime = createRuntime();
      const payload = valid({ name: text, item: text });
      const first = runtime.context.registerWithdrawal(payload);
      assert.equal(first.ok, true);
      assert.deepEqual(runtime.rows[1].slice(0, 2), [text, text]);
      assert.equal(runtime.state.rawWrites[0][0], "'" + text);
      assert.equal(runtime.state.rawWrites[0][1], "'" + text);
      assert.deepEqual(runtime.state.formulas, []);
      assert.equal(runtime.context.registerWithdrawal(payload).duplicate, true);
      assert.equal(runtime.rows.length, 2);
    });
  }
});

test('un reintento idéntico devuelve el registro original sin duplicar ni cambiar su fecha', () => {
  const runtime = createRuntime({ now: () => new Date('2026-10-30T18:42:00Z') });
  const first = runtime.context.registerWithdrawal(valid());
  const second = runtime.context.registerWithdrawal(valid());
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.registeredAt, first.registeredAt);
  assert.equal(runtime.state.appendCount, 1);
  assert.equal(runtime.rows.length, 2);
  assert.equal(runtime.state.releaseCount, 2);
});

test('el mismo identificador con otros datos se rechaza; otro identificador registra otro retiro', () => {
  const runtime = createRuntime();
  runtime.context.registerWithdrawal(valid());
  assert.throws(() => runtime.context.registerWithdrawal(valid({ item: 'Una llave' })), /otros datos/);
  assert.equal(runtime.rows.length, 2);
  assert.equal(runtime.context.registerWithdrawal(valid({ requestId: 'test-request-00000002' })).duplicate, false);
  assert.equal(runtime.rows.length, 3);
});

test('la búsqueda de identificadores exige coincidencia completa', () => {
  const original = ['Otra persona', 'Otro objeto', new Date('2026-10-29T12:00:00Z'), 'prefix-test-request-00000001-suffix'];
  const runtime = createRuntime({ initialRows: [HEADERS, original] });
  assert.equal(runtime.context.registerWithdrawal(valid()).duplicate, false);
  assert.equal(runtime.rows.length, 3);
});

test('un bloqueo ocupado no escribe ni devuelve una confirmación falsa', () => {
  const runtime = createRuntime({ lockAvailable: false });
  assert.throws(() => runtime.context.registerWithdrawal(valid()), /otro registro en curso/);
  assert.equal(runtime.rows.length, 1);
  assert.equal(runtime.state.appendCount, 0);
  assert.equal(runtime.state.releaseCount, 0);
});

test('una escritura fallida no devuelve éxito y libera el bloqueo para un reintento', () => {
  const runtime = createRuntime({ failAppend: true });
  assert.throws(() => runtime.context.registerWithdrawal(valid()), /escribir en la planilla/);
  assert.equal(runtime.rows.length, 1);
  assert.equal(runtime.state.releaseCount, 1);
  runtime.state.failAppend = false;
  assert.equal(runtime.context.registerWithdrawal(valid()).ok, true);
  assert.equal(runtime.rows.length, 2);
});

test('si falla la confirmación después de escribir, un reintento recupera la fila sin duplicarla', () => {
  const runtime = createRuntime({ failFlush: true });
  assert.throws(() => runtime.context.registerWithdrawal(valid()), /confirmar la escritura/);
  assert.equal(runtime.rows.length, 2);
  assert.equal(runtime.state.lockHeld, false);
  runtime.state.failFlush = false;
  assert.equal(runtime.context.registerWithdrawal(valid()).duplicate, true);
  assert.equal(runtime.rows.length, 2);
});

test('la confirmación usa la zona horaria de la planilla', () => {
  const runtime = createRuntime({ timezone: 'UTC' });
  assert.equal(runtime.context.registerWithdrawal(valid()).registeredAt, '30/10/2026 18:42:00');
  assert.equal(runtime.state.formatCalls[0].timezone, 'UTC');
});

test('una planilla sin configurar o con encabezados inesperados impide escribir', async t => {
  await t.test('sin propiedad de planilla', () => {
    const runtime = createRuntime({ configured: false });
    assert.throws(() => runtime.context.registerWithdrawal(valid()), /no está configurado/);
    assert.equal(runtime.rows.length, 1);
  });
  await t.test('hoja inexistente', () => {
    const runtime = createRuntime({ sheetExists: false });
    assert.throws(() => runtime.context.registerWithdrawal(valid()), /no está preparada/);
    assert.equal(runtime.state.releaseCount, 1);
  });
  await t.test('encabezados modificados', () => {
    const runtime = createRuntime({ initialRows: [['Nombre', 'Objeto', 'Fecha', 'ID']] });
    assert.throws(() => runtime.context.registerWithdrawal(valid()), /no está preparada/);
    assert.equal(runtime.rows.length, 1);
    assert.equal(runtime.state.releaseCount, 1);
  });
});

test('setup crea la hoja y los encabezados una vez; repetirlo conserva los registros', () => {
  const runtime = createRuntime({ configured: false, sheetExists: false, initialRows: [] });
  assert.match(runtime.context.setup_(), /America\/Santiago/);
  assert.deepEqual(runtime.rows, [HEADERS]);
  assert.equal(runtime.properties.get('SPREADSHEET_ID'), 'sheet-local-test');
  assert.equal(runtime.state.frozenRows, 1);
  assert.ok(runtime.state.hiddenColumns.includes(4));
  runtime.context.registerWithdrawal(valid());
  const snapshot = runtime.rows.map(row => Array.from(row));
  runtime.context.setup_();
  assert.deepEqual(runtime.rows, snapshot);
  assert.equal(runtime.rows.length, 2);
});

test('setup no reemplaza datos ni encabezados de una hoja existente desconocida', () => {
  const initialRows = [['Mis datos'], ['No borrar']];
  const runtime = createRuntime({ configured: false, initialRows });
  assert.throws(() => runtime.context.setup_(), /no está preparada/);
  assert.deepEqual(runtime.rows, initialRows);
  assert.equal(runtime.properties.has('SPREADSHEET_ID'), false);
  assert.equal(runtime.state.lockHeld, false);
});

test('setup exige ejecutarse desde una planilla vinculada', () => {
  const runtime = createRuntime({ configured: false, hasActiveSpreadsheet: false });
  assert.throws(() => runtime.context.setup_(), /Extensiones/);
  assert.equal(runtime.properties.has('SPREADSHEET_ID'), false);
});

test('configurarPlanilla ofrece una entrada visible en el editor y prepara la hoja sin borrar registros', () => {
  const runtime = createRuntime({ configured: false, sheetExists: false, initialRows: [] });
  assert.match(runtime.context.configurarPlanilla(), /America\/Santiago/);
  assert.deepEqual(runtime.rows, [HEADERS]);
  assert.equal(runtime.properties.get('SPREADSHEET_ID'), 'sheet-local-test');
  runtime.context.registerWithdrawal(valid());
  const snapshot = runtime.rows.map(row => Array.from(row));
  runtime.context.configurarPlanilla();
  assert.deepEqual(runtime.rows, snapshot);
});

test('configurarPlanilla rechaza llamadas de la web app sin una planilla activa antes de cambiar datos', () => {
  const runtime = createRuntime({ configured: false, hasActiveSpreadsheet: false });
  assert.throws(() => runtime.context.configurarPlanilla(), /Extensiones/);
  assert.equal(runtime.properties.has('SPREADSHEET_ID'), false);
  assert.deepEqual(runtime.rows, [HEADERS]);
  assert.equal(runtime.state.appendCount, 0);
  assert.equal(runtime.state.releaseCount, 0);
});

test('doGet sirve únicamente el formulario e incluye viewport para móviles', () => {
  const runtime = createRuntime();
  const output = runtime.context.doGet();
  assert.equal(output.file, 'Index');
  assert.equal(output.title, 'Retiros del almacén');
  assert.deepEqual(output.meta, [['viewport', 'width=device-width, initial-scale=1']]);
  assert.equal(runtime.state.appendCount, 0);
});
