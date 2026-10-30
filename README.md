# Registro de retiros del almacén

Una persona escanea el QR fijo, escribe su nombre y qué retiró, y pulsa **Registrar retiro**. No necesita cuenta ni contraseña. Los registros llegan a una **Google Sheet privada**, con las columnas Nombre, Objeto retirado y Fecha y hora. La hora proviene del servidor; no se utiliza el reloj del teléfono.

La aplicación usa Google Apps Script. No necesita un servidor propio ni claves API en el navegador. El nombre lo declara cada persona; no hay verificación de identidad ni control de inventario.

## Publicar el formulario

1. Crea una planilla en Google Sheets con la cuenta que administrará el registro. No la hagas pública.
2. En **Archivo → Configuración**, comprueba la **zona horaria** del taller. La fecha de los registros y la confirmación usan esa zona.
3. Abre **Extensiones → Apps Script**. Reemplaza el contenido del archivo `Código.gs` por [Code.gs](Code.gs).
4. Añade un archivo de tipo HTML llamado **Index** y copia [Index.html](Index.html).
5. Guarda el código. En la barra superior del editor, abre el selector que inicialmente muestra **doGet**, selecciona **`configurarPlanilla`** y pulsa **▶ Ejecutar**. Autoriza el acceso a tus hojas de cálculo. Esta función crea la pestaña **Registros**, sus encabezados y una columna técnica oculta para evitar duplicados. Se puede volver a ejecutar sin borrar filas. No cambies esos encabezados ni borres la columna oculta. La función interna `setup_` no aparece en el selector porque Apps Script oculta las funciones terminadas en `_`.
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

## Activar copia y registro nuevo cada mes

Esta opción es voluntaria. Si no la activas, los registros continúan acumulándose como antes. Con la opción activada, cada cierre mensual guarda un archivo separado en Google Drive y prepara una pestaña **Registros** vacía para el mes siguiente. El formulario, el enlace y el QR se conservan.

1. Desde la planilla principal, abre **Extensiones → Apps Script**. Reemplaza **todo** el contenido de `Código.gs` por la versión actual de [Code.gs](Code.gs). Si añadiste manualmente `configurarPlanilla`, no la añadas otra vez: ya viene incluida. No necesitas cambiar `Index.html`.
2. Si usas un manifiesto con `oauthScopes` explícitos, copia también [appsscript.json](appsscript.json): ahora incluye permisos para crear copias en Drive y gestionar el activador. Puedes mostrar este archivo desde **Configuración del proyecto → Mostrar el archivo de manifiesto appsscript.json**. Si tu manifiesto tiene otras opciones propias, conserva esas opciones y añade los tres permisos que aparecen en el archivo del proyecto.
3. Guarda y ejecuta **configurarPlanilla** desde el selector superior del editor. Los registros existentes se conservan.
4. Actualiza primero el formulario que usa el QR: **Implementar → Administrar implementaciones → Editar → Nueva versión → Implementar**, sobre la implementación existente. Autoriza de nuevo si se solicita. Mantén **Ejecutar como: Yo** y acceso **Cualquiera**. No crees otra implementación ni cambies el QR. Así el formulario y la tarea mensual usarán el mismo código cuando actives los cierres.
5. Selecciona **configurarRespaldoMensual** y pulsa **▶ Ejecutar**, usando la misma cuenta que administra la aplicación. Acepta los permisos adicionales de Google para Drive y para la automatización. Ejecutar otra vez esta función reutiliza la carpeta y evita instalar activadores duplicados de esa cuenta.
6. Se crea la carpeta **Respaldos del almacén** en tu Google Drive. El vínculo aparece en **Registro de ejecución**. La carpeta y las nuevas copias se crean con acceso restringido; puedes compartir la carpeta con el correo de tu jefe como **Lector** para que vea los archivos que se vayan agregando.

### Qué sucede al cambiar de mes

- El activador se programa para el **día 1, alrededor de la 01:00**, según la zona horaria de la planilla. Google no garantiza un minuto exacto. Si llega un retiro antes de que se ejecute el activador, el propio registro hace el cierre pendiente antes de guardar ese retiro.
- La tarea se ejecuta en Google aunque el computador esté apagado o nadie tenga abierta la planilla.
- Se copia la pestaña del mes que terminó a un **archivo de Google Sheets separado**, dentro de la carpeta de respaldos. Se comprueba que coincidan los nombres, objetos, fechas e identificadores antes de cambiar la pestaña principal.
- Los datos anteriores también permanecen en la planilla original, en una pestaña como **Registros_2026-10**. Se crea una nueva **Registros** con los mismos encabezados. No se borran las filas anteriores.
- Si ya había registros acumulados cuando activaste la opción, la **primera copia incluye todos esos registros**. Los cierres posteriores separan los meses desde la activación.
- Si falla la copia o su verificación, el cierre se detiene conservando los datos. El siguiente activador o intento de registro vuelve a intentar completar el cierre. Si el formulario informa del error, el encargado debe revisar los permisos y el espacio disponible en Drive antes de reintentar.

No renombres ni borres las pestañas históricas ni la carpeta de respaldos: se usan para recuperar cierres interrumpidos y reconocer reintentos sin duplicarlos. Las copias mensuales conservan los estados al cierre, no cada edición intermedia. Al estar en la misma cuenta de Google, puedes además descargar un Excel y guardarlo en otro lugar si necesitas un respaldo independiente de esa cuenta.

Para revisar la automatización, abre el icono de **reloj / Activadores** de Apps Script: debe aparecer un único activador de tu cuenta para **cerrarMesAutomatico_**.

La instalación y las pruebas de este repositorio no activan nada en tu cuenta de Google. La cuenta administradora debe completar estos pasos y comprobar en Google el primer cierre real.

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

El sistema necesita conexión a Internet y está pensado para el uso ligero de un taller. Está sujeto a las cuotas y disponibilidad de Google Apps Script y Sheets. Para cambiar la planilla de destino, abre el script desde la nueva planilla y vuelve a ejecutar `configurarPlanilla`; no introduzcas credenciales en el código.

Si ya copiaste una versión anterior que solo muestra **doGet** y **registerWithdrawal**, añade al final de `Código.gs` lo siguiente, guarda y selecciona **configurarPlanilla**:

```js
function configurarPlanilla() {
  return setup_();
}
```

La configuración exige ejecutarse desde el editor vinculado a la planilla. Las llamadas del formulario público no tienen una planilla activa y se rechazan antes de modificar datos o configuración.
