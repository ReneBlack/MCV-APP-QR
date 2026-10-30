# Registro de retiros del almacén

Una persona escanea el QR fijo, escribe su nombre y qué retiró, y pulsa **Registrar retiro**. No necesita cuenta ni contraseña. Los registros llegan a una **Google Sheet privada**, con las columnas Nombre, Objeto retirado y Fecha y hora. La hora proviene del servidor; no se utiliza el reloj del teléfono.

La aplicación usa Google Apps Script. No necesita un servidor propio ni claves API en el navegador. El nombre lo declara cada persona; no hay verificación de identidad ni control de inventario.

## Publicar el formulario

1. Crea una planilla en Google Sheets con la cuenta que administrará el registro. No la hagas pública.
2. En **Archivo → Configuración**, comprueba la **zona horaria** del taller. La fecha de los registros y la confirmación usan esa zona.
3. Abre **Extensiones → Apps Script**. Reemplaza el contenido del archivo `Código.gs` por [Code.gs](Code.gs).
4. Añade un archivo de tipo HTML llamado **Index** y copia [Index.html](Index.html).
5. Guarda y ejecuta **`setup_`** desde el selector de funciones del editor. Autoriza el acceso a tus hojas de cálculo. Esta función crea la pestaña **Registros**, sus encabezados y una columna técnica oculta para evitar duplicados. Se puede volver a ejecutar sin borrar filas. No cambies esos encabezados ni borres la columna oculta.
6. Pulsa **Implementar → Nueva implementación → Aplicación web**. Selecciona **Ejecutar como: Yo** y **Quién tiene acceso: Cualquiera**. La opción debe permitir usuarios anónimos; algunas organizaciones de Google Workspace la restringen.
7. Copia la **URL de la aplicación web**, terminada en **`/exec`**. El enlace `/dev` es solo para pruebas del propietario.
8. Abre `/exec` en una ventana de incógnito, sin iniciar sesión en Google. Envía un retiro de prueba y comprueba su nombre, objeto y fecha/hora en la planilla. Si aparece una pantalla de acceso a Google, revisa el acceso de la implementación antes de imprimir.

El manifiesto [appsscript.json](appsscript.json) es opcional al copiar los dos archivos: Apps Script genera uno. Para usar el incluido, activa **Mostrar el archivo de manifiesto** en la configuración del proyecto y copia su contenido. Su zona inicial es `America/Santiago`; ajusta esta y la zona de la planilla si tu taller usa otra.

Solo el propietario autoriza el acceso a la planilla. Quienes usan el formulario no reciben su ID, su enlace ni sus registros. El acceso público permite enviar datos a quien tenga el enlace; no compartas la planilla para habilitar el formulario.

## Crear la hoja con el QR

Con Node.js 24 o posterior:

```sh
cd /workspace/MCV-APP-QR
npm ci
npm run qr -- 'https://script.google.com/macros/s/TU_IMPLEMENTACION/exec'
```

Usa el **enlace real** del paso anterior, no el ejemplo. Abre el archivo generado `dist/qr-almacen.html` en tu navegador e imprime en A4. Antes de pegarlo en la puerta, escanea la hoja con un teléfono y registra un retiro de prueba. El QR se genera localmente, sin enviar el enlace a un proveedor externo.

Para modificar la aplicación conservando el mismo QR: **Implementar → Administrar implementaciones → Editar → Nueva versión → Implementar** sobre la implementación existente. Crear otra implementación puede generar un enlace diferente y obligar a reimprimir el QR.

## Desarrollo y pruebas

```sh
cd /workspace/MCV-APP-QR
npm ci
npm test
npm run dev
```

El servidor de desarrollo escucha solo en loopback, puerto 3000 (variable `PORT` para cambiarlo). Es una simulación local de los servicios de Google: ejecuta el mismo `Code.gs`, pero guarda los registros en memoria y se borran al detenerlo. No conecta con la planilla de producción. `npm test` comprueba validación, escritura, hora del servidor, reintentos, errores y comportamiento del formulario usando dobles de prueba de Apps Script. La integración real con Google y el acceso anónimo requieren el paso 8 de publicación.

No hay compilación: `Code.gs` e `Index.html` se ejecutan directamente en Apps Script. La única dependencia npm sirve para generar el QR y no se carga en el formulario publicado.

## Uso del registro

Abre la planilla para consultar, filtrar o descargar los datos con **Archivo → Descargar → Microsoft Excel (.xlsx)**. La fecha se guarda como fecha real, no como texto. El formulario confirma solo cuando el servidor termina de escribir; si falla, conserva los campos para reintentar. Evita pulsar atrás y reenviar un retiro que ya recibiste como confirmado.

El sistema necesita conexión a Internet y está pensado para el uso ligero de un taller. Está sujeto a las cuotas y disponibilidad de Google Apps Script y Sheets. Para cambiar la planilla de destino, abre el script desde la nueva planilla y vuelve a ejecutar `setup_`; no introduzcas credenciales en el código.
