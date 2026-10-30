import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../Index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 1, 'El formulario debe tener su script autocontenido');
const script = new vm.Script(scripts[0][1], { filename: 'Index.html' });

// Simula únicamente las operaciones DOM usadas por el formulario. No sustituye
// la validación de un navegador, pero ejecuta el JavaScript real de Index.html.
function createForm({ available = true, cryptoAvailable = true } = {}) {
  const ids = [
    'withdrawal-form', 'fields', 'name', 'item', 'notice',
    'button-label', 'spinner',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, {
    value: '',
    textContent: '',
    className: '',
    disabled: false,
    hidden: false,
    customValidity: '',
    attributes: {},
    listeners: new Map(),
    addEventListener(type, handler) { this.listeners.set(type, handler); },
    setAttribute(name, value) { this.attributes[name] = value; },
    setCustomValidity(message) { this.customValidity = message; },
    focus() { this.focused = true; },
    set innerHTML(_) { throw new Error('No se debe interpretar contenido como HTML'); },
  }]));
  const form = elements['withdrawal-form'];
  form.reportValidity = () => ['name', 'item'].every((id) => (
    elements[id].value !== '' && elements[id].customValidity === ''
  ));

  const requests = [];
  let nextId = 0;
  const run = {
    withSuccessHandler(callback) { this.success = callback; return this; },
    withFailureHandler(callback) { this.failure = callback; return this; },
    registerWithdrawal(payload) {
      requests.push({
        payload: JSON.parse(JSON.stringify(payload)),
        success: this.success,
        failure: this.failure,
      });
    },
  };
  const google = available ? { script: { run } } : undefined;
  const window = { google };
  if (cryptoAvailable) {
    window.crypto = {
      randomUUID: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    };
  }
  script.runInNewContext({
    window,
    google,
    document: {
      getElementById(id) {
        assert.ok(elements[id], `Elemento DOM desconocido: ${id}`);
        return elements[id];
      },
    },
    Uint8Array,
  });

  return {
    elements,
    requests,
    submit() {
      let prevented = false;
      form.listeners.get('submit')({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true, 'El formulario no debe navegar al enviar');
    },
    fill(name = 'Ana Pérez', item = '2 cajas de guantes') {
      this.edit('name', name);
      this.edit('item', item);
    },
    edit(id, value) {
      elements[id].value = value;
      elements[id].listeners.get('input')();
    },
  };
}

test('envía nombre y objeto limpios con UUID y bloquea envíos simultáneos', () => {
  const app = createForm();
  app.fill('  Ana Pérez  ', '  2 cajas de guantes  ');
  app.submit();
  app.submit();

  assert.equal(app.requests.length, 1);
  assert.deepEqual(app.requests[0].payload, {
    name: 'Ana Pérez',
    item: '2 cajas de guantes',
    requestId: '00000000-0000-4000-8000-000000000001',
  });
  assert.equal(app.elements.fields.disabled, true);
  assert.equal(app.elements['withdrawal-form'].attributes['aria-busy'], 'true');
  assert.equal(app.elements['button-label'].textContent, 'Guardando…');
  assert.equal(app.elements.spinner.hidden, false);
});

test('confirma con hora del servidor, conserva nombre y permite otro retiro distinto', () => {
  const app = createForm();
  app.fill();
  app.submit();
  app.requests[0].success({ ok: true, registeredAt: '30/10/2026 15:42:00' });

  assert.equal(app.elements.name.value, 'Ana Pérez');
  assert.equal(app.elements.item.value, '');
  assert.equal(app.elements.item.focused, true);
  assert.match(app.elements.notice.textContent, /Retiro registrado.*30\/10\/2026 15:42:00/);
  assert.equal(app.elements.notice.attributes.role, 'status');
  assert.equal(app.elements.fields.disabled, false);
  assert.equal(app.elements['withdrawal-form'].attributes['aria-busy'], 'false');
  assert.equal(app.elements.spinner.hidden, true);

  app.edit('item', '1 martillo');
  app.submit();
  assert.equal(app.requests.length, 2);
  assert.notEqual(app.requests[1].payload.requestId, app.requests[0].payload.requestId);
});

test('un error conserva los datos y el identificador al reintentar', () => {
  const app = createForm();
  app.fill();
  app.submit();
  app.requests[0].failure({ message: 'Sin conexión' });

  assert.equal(app.elements.name.value, 'Ana Pérez');
  assert.equal(app.elements.item.value, '2 cajas de guantes');
  assert.equal(app.elements.notice.textContent, 'Sin conexión');
  assert.equal(app.elements.notice.attributes.role, 'alert');
  assert.equal(app.elements.fields.disabled, false);
  app.submit();
  assert.equal(app.requests.length, 2);
  assert.deepEqual(app.requests[1].payload, app.requests[0].payload);
});

test('editar un retiro después de un error crea un identificador distinto', () => {
  const app = createForm();
  app.fill();
  app.submit();
  app.requests[0].failure({ message: 'Sin conexión' });
  app.edit('item', '3 cajas de guantes');
  app.submit();
  assert.notEqual(app.requests[1].payload.requestId, app.requests[0].payload.requestId);
  assert.equal(app.requests[1].payload.item, '3 cajas de guantes');
});

test('no envía campos vacíos ni espacios y permite corregirlos', () => {
  for (const [name, item] of [['', 'Guantes'], ['Ana', ''], ['   ', 'Guantes'], ['Ana', '\t  ']]) {
    const app = createForm();
    app.fill(name, item);
    app.submit();
    assert.equal(app.requests.length, 0);
    assert.equal(app.elements.fields.disabled, false);

    app.fill();
    app.submit();
    assert.equal(app.requests.length, 1);
  }
});

test('muestra mensajes remotos como texto sin interpretar HTML', () => {
  const app = createForm();
  app.fill();
  app.submit();
  const attack = '<img src=x onerror="alert(1)">';
  app.requests[0].failure({ message: attack });
  assert.equal(app.elements.notice.textContent, attack);

  app.submit();
  app.requests[1].success({ ok: true, registeredAt: attack });
  assert.equal(app.elements.notice.textContent, `Retiro registrado. ${attack}. Gracias.`);
});

test('una respuesta inválida muestra error y conserva el retiro para reintentar', () => {
  for (const response of [undefined, null, {}, { ok: false }, { ok: 'true' }]) {
    const app = createForm();
    app.fill();
    app.submit();
    app.requests[0].success(response);

    assert.match(app.elements.notice.textContent, /No pudimos confirmar el registro/);
    assert.equal(app.elements.notice.attributes.role, 'alert');
    assert.equal(app.elements.item.value, '2 cajas de guantes');
    assert.equal(app.elements.fields.disabled, false);
    app.submit();
    assert.equal(app.requests[1].payload.requestId, app.requests[0].payload.requestId);
  }
});

test('si el servicio no está disponible informa el problema sin perder datos', () => {
  const app = createForm({ available: false });
  app.fill();
  app.submit();
  assert.equal(app.requests.length, 0);
  assert.match(app.elements.notice.textContent, /Vuelve a abrir el enlace del QR/);
  assert.equal(app.elements.fields.disabled, false);
  assert.equal(app.elements.item.value, '2 cajas de guantes');
});

test('genera identificadores UUID válidos aunque randomUUID no esté disponible', () => {
  const app = createForm({ cryptoAvailable: false });
  app.fill();
  app.submit();
  assert.match(app.requests[0].payload.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
