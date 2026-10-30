import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import qrcode from 'qrcode-generator';

const escapeHtml = value => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

export function printableQr(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Indica la URL pública de Google Apps Script terminada en /exec.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' ||
      !/^\/macros\/s\/[^/]+\/exec$/.test(url.pathname) || url.username || url.password || url.search || url.hash) {
    throw new Error('Usa el enlace HTTPS de la implementación: https://script.google.com/macros/s/…/exec (sin parámetros).');
  }
  const code = qrcode(0, 'M');
  code.addData(url.href, 'Byte');
  code.make();
  const svg = code.createSvgTag({ cellSize: 8, margin: 32, scalable: true });
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>QR · Almacén del taller</title><style>
body{font-family:Arial,sans-serif;color:#163c36;text-align:center;margin:0;padding:28px;background:#f3f6f1}
main{max-width:700px;margin:auto;padding:40px;background:white;border:2px solid #155b52;border-radius:20px}
h1{font-size:38px;margin:0 0 14px}p{font-size:21px;line-height:1.5}svg{display:block;width:100%;max-width:150mm;height:auto;margin:20px auto}
.link{font-size:11px;overflow-wrap:anywhere;color:#536760}button{padding:14px 24px;border:0;border-radius:9px;background:#155b52;color:white;font-size:17px;cursor:pointer}
@page{size:A4 portrait;margin:15mm}@media print{body{padding:0;background:white}main{padding:20px}button{display:none}}
</style><main><h1>¿Sacas algo del almacén?</h1><p>Escanea este QR con la cámara del teléfono.<br>Escribe tu nombre y qué retiraste.</p>
${svg}<p><strong>Regístralo antes de salir.</strong><br>¡Gracias!</p><p class="link">${escapeHtml(url.href)}</p>
<button onclick="window.print()">Imprimir hoja</button></main></html>`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const html = printableQr(process.argv[2]);
    const output = resolve(process.argv[3] || 'dist/qr-almacen.html');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, html);
    console.log(`Hoja imprimible creada: ${output}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
