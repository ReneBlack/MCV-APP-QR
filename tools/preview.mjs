import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '../tests/support/apps-script.mjs';

const shim = `<script>
window.google = {script: {get run() {
  const runner = {
    withSuccessHandler(callback) { this.success = callback; return this; },
    withFailureHandler(callback) { this.failure = callback; return this; },
    registerWithdrawal(payload) {
      fetch('/api/withdrawals', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)})
        .then(async response => {
          const result = await response.json();
          if (!response.ok) throw new Error(result.message || 'No se pudo guardar el retiro.');
          return result;
        }).then(result => this.success(result)).catch(error => this.failure(error));
    }
  };
  return runner;
}}};
</script>`;

/** Loopback-only simulation. Production always uses Google's own services. */
export async function createPreviewServer() {
  const runtime = createRuntime({ configured: false, sheetExists: false, initialRows: [], now: () => new Date() });
  runtime.context.setup_();
  const source = await readFile(new URL('../Index.html', import.meta.url), 'utf8');
  const html = source.replace('<body>', '<body><p style="margin:0;padding:10px;background:#f5edce;text-align:center;font:13px sans-serif">Prueba local: los registros son temporales y no llegan a Google Sheets.</p>')
    .replace('<script>', shim + '<script>');
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    if (request.method === 'POST' && request.url === '/api/withdrawals') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 8192) throw new Error('El registro es demasiado largo.');
        }
        const result = runtime.context.registerWithdrawal(JSON.parse(body));
        response.end(JSON.stringify(result));
      } catch (error) {
        response.statusCode = 400;
        response.end(JSON.stringify({ message: error.message }));
      }
      return;
    }
    response.writeHead(404);
    response.end('No encontrado');
  });
  return { server, runtime };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3000);
  const { server } = await createPreviewServer();
  server.listen(port, '127.0.0.1', () => console.log(`Simulación local activa en el puerto ${server.address().port}. Registros solo en memoria.`));
}
