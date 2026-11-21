# Aqua Sentinel

**Monitoreo, diagnóstico y trazabilidad para sistemas comunitarios de agua.** Prototipo de hackathon (Kiroween 2026). Todos los datos de la red *San Cristóbal de las Aguas* son **sintéticos de demostración**.

`Dato → Anomalía → Correlación → Diagnóstico → Decisión → Orden de Trabajo → Expediente sellado`

## Arquitectura

| Capa | Módulos | Notas |
| --- | --- | --- |
| Núcleo puro | `src/core/` | Reglas deterministas, validación de telemetría, diagnóstico hidráulico (balance de masa con incertidumbre), concordancia de evidencias, ledger SHA-256, expediente. Sin dependencias de servidor, simulación ni React. |
| Simulación | `src/sim/` | Solver hidráulico (Hazen-Williams), generador de escenarios con semilla y evaluación Monte Carlo. Nunca lo importa el código de detección. |
| Servidor | `server.ts`, `src/server/` | Express 4. Las mutaciones pasan por una exclusión mutua FIFO; las llamadas a IA se hacen fuera del cerrojo con control de época. |
| Cliente | `src/App.tsx`, `src/components/` | React 19 + Vite. `ErrorBoundary` evita la pantalla en blanco. |
| Kiro | `.kiro/specs`, `.kiro/steering`, `.kiro/hooks` | Requisitos `REQ-*` trazados a código y pruebas; `npm run verify:kiro` lo comprueba. |

## Ejecución y pruebas

```bash
npm ci               # instala desde package-lock.json (lockfile canónico)
npm test             # todas las pruebas: tsx --test "src/**/*.test.ts"
npm run lint         # tsc --noEmit
npm run build        # vite build
npm run verify:kiro  # trazabilidad REQ-*, pruebas, tipos y build
npm run dev          # Express + Vite en el puerto 3000
npm start            # producción (tras build)
```

Requiere Node >= 22.


## Modo público

Pensado para presentar Aqua Sentinel: cualquiera abre la URL y explora la plataforma **sin iniciar sesión, sin registrarse y sin código de administrador**. No es una versión sin seguridad: es un modo explícito, de solo lectura y reversible.

```bash
npm run public        # equivale a AQUA_PUBLIC_MODE=1 npm run dev, con el estado aislado en data/public-demo/
```

Al arrancar por primera vez se siembra solo una demostración con datos **simulados**: un incidente (fuga en la troncal), su diagnóstico, una foto de ejemplo y una orden de trabajo en curso. El visitante navega por Inicio, Mapa, Incidentes y Órdenes de trabajo, y puede abrir las herramientas avanzadas. No puede modificar nada.

### Qué rutas son públicas

Un visitante sin sesión solo supera estas rutas. Todas son de lectura (`GET`):

| Ruta | Para qué | Notas |
| --- | --- | --- |
| `/api/state` | Estado de la demostración | Versión redactada: sin rutas del servidor ni mensajes internos |
| `/api/events` | Actualizaciones en vivo | Mismo contenido redactado; máximo 20 conexiones por IP |
| `/api/evidence/:sha256` | Fotos de la demostración | Solo con un SHA-256 exacto de 64 caracteres hexadecimales |

Siguen siendo públicas, como siempre, las rutas de acceso: `GET /api/health` (solo «vivo»), `GET /api/seal/public-key`, `GET /api/auth/status`, `GET /api/auth/csrf`, `POST /api/auth/login` y `POST /api/auth/setup` (esta última deshabilitada en modo público).

### Qué sigue protegido

**Todo lo demás exige sesión, CSRF y el permiso del rol**, igual que antes: toda escritura (`POST`, `PATCH`, `PUT`, `DELETE`), la IA, la ingesta de telemetría, las órdenes, los expedientes, la exportación e importación de snapshots, el reinicio y la demostración guiada (que además piden contraseña y token de un solo uso), los usuarios, la auditoría y `/api/kiro/files`. Una prueba recorre **todas** las rutas registradas y falla si alguna distinta de las anteriores responde a un visitante.

El visitante no es un usuario: no existe en `auth.json`, no tiene sesión y su único rol, `VISITOR`, solo concede `state:read` y `evidence:read` (`src/core/permissions.ts`). Nunca se le trata como operador ni como administrador.

### Aislamiento de los datos

- La instancia pública usa su propio estado en `data/public-demo/` (no toca `data/aqua-sentinel-state.json`). Se niega a arrancar si el estado contiene lecturas que no sean sintéticas.
- En modo público `AQUA_FIELD_DATA` se ignora: toda lectura que llegue se marca como simulada.
- La demostración se siembra con la API real y una cuenta interna `demo.seed` (rol OPERATOR, contraseña aleatoria que nunca se guarda, desactivada al terminar). Aparece en el registro como «Preparación de la demostración».
- Los tiempos de una demostración envejecen. Si el estado tiene más de 12 h al arrancar se descarta **solo ese archivo** y se vuelve a sembrar (usuarios, auditoría y clave de sellado no se tocan). `AQUA_PUBLIC_KEEP_STATE=1` lo desactiva.
- Si se inicia sesión en una instancia pública, lo que haga ese usuario queda en la demostración y es visible para los visitantes, nombres incluidos. Usa cuentas de demostración, no personales.

### Activarlo y desactivarlo

| Variable | Efecto |
| --- | --- |
| `AQUA_PUBLIC_MODE=1` (o `--public`) | Activa el modo público. Sin ella, toda ruta exige sesión. |
| `AQUA_PUBLIC_KEEP_STATE=1` | No descartar la demostración con más de 12 h. |
| `AQUA_MEDIA_ORIGINS` | Orígenes https autorizados para reproducir un video alojado fuera (por defecto, solo este servidor). |

Para volver al modo privado basta con arrancar sin la variable. Para operar con usuarios en la instancia pública, créalos con `npm run auth -- create-admin <usuario> --public` y usa «Iniciar sesión» en el menú.

En un despliegue (`NODE_ENV=production`) siguen siendo obligatorios `AQUA_ALLOWED_HOSTS` y `AQUA_ALLOWED_ORIGINS`. Detrás de un proxy define `AQUA_TRUSTED_PROXIES`: si no, todos los visitantes comparten una IP y el cupo anónimo (600 peticiones por minuto en modo público, ajustable con `AQUA_RATE_LIMITS`) se agota para todos.

### Video explicativo

La pantalla de Inicio muestra, dentro del encabezado, un reproductor 16:9 con portada. El video incluido (`public/videos/aqua-sentinel-explicativo.mp4`, 16,5 s, sin audio) es una **animación ilustrativa generada por código con datos simulados**, no un video institucional con locución ni imágenes de campo. Si el archivo no existe o `enabled` es false, muestra «Video explicativo próximamente» y no simula ninguna reproducción. Para reemplazarlo copia el archivo a `public/videos/aqua-sentinel-explicativo.mp4` y ajusta `public/config/intro-video.json` (ahí también se cambian la ruta, la portada y los subtítulos). Más detalles en `public/videos/LEEME.txt`. La reproducción es siempre bajo demanda, sin autoplay.

## Interfaz

Cuatro apartados, en un menú desplegable: **Inicio** (presentación con video, estado de la red y qué hacer ahora), **Mapa**, **Incidentes** (qué pasa, qué significa y qué hacer) y **Órdenes de trabajo**. Las herramientas técnicas (series de sensores, evidencia visual, Trust Ledger, conexión e integraciones, demostración) están en **Herramientas avanzadas**, desde el menú de usuario.

Cada dato indica su procedencia: **MEDIDO** (sensor), **DECLARADO** (una persona), **INFERIDO** (reglas y cálculos, sin IA), **HIPÓTESIS IA** (modelo generativo) y **SIMULADO** (dato sintético de demostración). Una hipótesis nunca se presenta como hecho. La interfaz respeta el rol (Lector, Operador, Administrador) usando la misma matriz de permisos que el servidor (`src/core/permissions.ts`), pero la autorización real siempre es la del servidor.

Defectos del servidor que la interfaz muestra tal como son, sin maquillarlos: un reporte declarado se cuenta en el servidor como respaldo de «sensores» (la interfaz lo muestra como declarado) y al cerrar una orden el servidor escribe una lectura «restaurada» que no es una medición (la interfaz muestra el punto como pendiente de verificación hasta que haya mediciones posteriores). Siguen pendientes de corregir en el servidor.
## Acceso y seguridad (Fase 2)

Toda la API exige sesión (denegación por defecto). Solo son públicos `GET /api/health` (solo "vivo"), `GET /api/seal/public-key`, y las rutas de inicio de sesión.

**Roles** (matriz en `src/server/authz.ts`, aplicada en el servidor):

| Rol | Puede |
| --- | --- |
| VIEWER | Consultar estado, ledger, evidencias y verificar expedientes. |
| OPERATOR | Lo anterior, más ingesta, escenarios, IA, decisiones, órdenes, evidencias, exportar expedientes y sincronizar reportes offline. |
| ADMIN | Todo, más usuarios, auditoría, exportar snapshots, sonda de IA y operaciones destructivas. |

**Primer administrador** (no hay credenciales por defecto):

```bash
# Recomendado, y obligatorio en producción: CLI (la contraseña se pide sin eco o por stdin)
npm run auth -- create-admin <usuario>
npm run auth -- create-user <usuario> --role OPERATOR
npm run auth -- reset-password <usuario>
npm run auth -- list
```

En desarrollo, si no hay usuarios, el servidor imprime un código de UN solo uso (15 min, no se guarda en claro) que se introduce en la pantalla de configuración inicial. Al crearse el primer usuario ese asistente queda cerrado para siempre. En producción está deshabilitado salvo `AQUA_SETUP_ENABLED=1`.

**Operaciones destructivas** (reset, demo, import): ADMIN + contraseña de nuevo + token de un solo uso de 60 s + confirmación explícita. La autorización se escribe en la auditoría antes de ejecutar y el estado anterior se archiva en `backups/`; si cualquiera de las dos cosas falla, no se ejecuta. `auth.json` y `audit.jsonl` no se ven afectados.

## Variables de entorno

| Variable | Efecto |
| --- | --- |
| `GEMINI_API_KEY` | Opcional. Habilita análisis de imagen y redacción del diagnóstico con Gemini. Sin clave, todo el flujo crítico sigue con el adaptador determinista, declarado en la interfaz. |
| `GEMINI_MODEL` | Modelo a usar. El valor por defecto `gemini-2.5-flash` **no está validado con clave real** y, según la documentación de Google, es un modelo heredado que se redirigirá desde el 2026-12-01. Fija y valida el modelo antes de depender de él. |
| `GEMINI_TIMEOUT_MS` / `GEMINI_TOTAL_BUDGET_MS` | Tiempo por llamada (15000) y presupuesto total por enriquecimiento (30000). |
| `AQUA_ALLOWED_HOSTS` | **Obligatoria en producción.** Valores permitidos de la cabecera `Host` (`host`, `host:puerto` o `host:*`). Evita DNS rebinding. En desarrollo se aceptan `localhost`, `127.0.0.1` y `[::1]`. |
| `AQUA_ALLOWED_ORIGINS` | **Obligatoria en producción.** Orígenes (`https://aqua.ejemplo.org`) que pueden enviar escrituras. |
| `AQUA_TRUSTED_PROXIES` | IP de proxys inversos de confianza. Solo entonces se leen `X-Forwarded-For` y `X-Forwarded-Proto`; `X-Forwarded-Host` nunca se usa (el proxy debe conservar `Host`). |
| `AQUA_PUBLIC_MODE=1` | Modo público de solo lectura y datos simulados (ver «Modo público»). |
| `AQUA_SETUP_ENABLED=1` | Habilita el asistente web del primer administrador en producción (se prefiere el CLI). |
| `AQUA_SESSION_IDLE_MS` / `AQUA_SESSION_ABSOLUTE_MS` | Caducidad por inactividad (30 min) y absoluta (12 h). |
| `AQUA_RATE_LIMITS` | JSON para ajustar cupos por cubeta (`login-ip`, `login-user`, `setup`, `api-anon`, `api-user`, `ai`, `ai-probe`, `upload`, `admin`, `reauth`), p. ej. `{"ai":{"max":10,"windowMs":60000}}`. |
| `AQUA_FIELD_DATA=1` | Permite que la telemetría externa se marque como dato de campo; por defecto toda lectura externa se fuerza a sintética. |
| `AQUA_SEAL_PRIVATE_KEY_PEM` | Clave Ed25519 de sellado. Si falta, se usa `seal-key.pem` junto al estado o una clave efímera que se declara como tal. |
| `AQUA_STATE_PATH`, `HOST`, `PORT` | Ubicación del estado (y de `auth.json`, `audit.jsonl`, `backups/`) y red. `HOST` es `127.0.0.1` por defecto. |

Se eliminaron `AQUA_ADMIN_TOKEN` y `AQUA_ALLOW_DESTRUCTIVE`: el primero era un secreto compartido sin identidad y el segundo desactivaba la autenticación.

En producción usa HTTPS delante (proxy inverso). La cookie de sesión lleva `Secure` y prefijo `__Host-`; sobre HTTP en un host distinto de `localhost` el navegador la rechazará.

## Expediente verificable

Al cerrar una orden se congela y sella el expediente completo (anomalía, telemetría, diagnóstico, visión, hidráulica, orden y evidencia). Para verificarlo fuera del servidor:

```bash
npm run verify:dossier -- expediente.json --keyid <huella-de-la-clave-publicada>
```

La verificación separa tres cosas: **integridad** (la cadena y las huellas coinciden), **autenticidad** (solo si fijas la clave pública por un canal independiente con `--pubkey` o `--keyid`) e **inmutabilidad** (nunca garantizada: quien controla el servidor puede volver a firmar). Códigos de salida: 0 verificado, 3 solo integridad, 1 alterado o inválido, 2 uso incorrecto.

## Qué es real y qué no

- **Real**: motor determinista, solver hidráulico contrastado con EPANET (`epanet-js`, 8 casos, diferencia máxima 0.0027 bar y 0.0007 L/s), ledger SHA-256, firma Ed25519, validaciones, persistencia en archivo.
- **Simulado o sin validar**: los datos de la red (sintéticos), los adaptadores AWS (S3, Lambda, DynamoDB), Bedrock (no configurado), Gemini texto y visión (sin validar con credenciales reales; las pruebas usan un endpoint simulado solo para el manejo de errores).
- **Visión**: sin proveedor real la foto queda "no analizada". No se clasifica por nombre, ruta ni URL.
- **Confianza**: no se muestran porcentajes. El nivel de respaldo (baja/media/alta/en conflicto) se deriva de los canales realmente medidos y vinculados al incidente.

## Límites hidráulicos

- Resolución espacial: el tramo entre dos medidores. El caudal perdido es una estimación del balance de masa con su incertidumbre.
- Límite de detección en la simulación: unos 4.5 L/s en la toma. Pérdidas menores se reportan, como mucho, como anomalía de caudal.
- La corroboración por presión necesita pérdidas del orden de 10 a 12 L/s.
- Tramos con bombeo y salidas de tanque no son observables con los medidores actuales; no hay balance de almacenamiento del tanque.
- La fórmula de Hazen-Williams es común al solver y al diagnóstico; EPANET valida el solver, no la red real.

## Seguridad: límites conocidos

- **La auditoría no es inmutable frente al administrador del servidor.** La cadena de hashes y la firma de su cabeza detectan ediciones, borrados y truncados hechos por terceros; quien controla el servidor (y la clave de sellado) puede reescribir y volver a firmar. Para una garantía real copia periódicamente `GET /api/audit/head` a un sistema ajeno al operador. No hay rotación ni retención automática: `audit.jsonl` crece mientras no se archive.
- **El limitador de tasa es en memoria de un solo proceso:** se reinicia con el servidor y no se comparte entre réplicas. Detrás de un proxy sin `AQUA_TRUSTED_PROXIES` todos los clientes comparten una IP. El bloqueo por cuenta puede usarse para molestar a un usuario concreto.
- No hay gestión de usuarios en la interfaz: se hace por API (`/api/users`) o con el CLI. No hay autenticación de dos factores, ni caducidad de contraseñas, ni recuperación por correo.
- Los archivos estáticos (la aplicación y sus recursos) se sirven sin sesión para poder mostrar el inicio de sesión; los datos no.
- Los tokens de operación destructiva viven en memoria: un reinicio los invalida (deseado), pero también significa que no sirve con varias réplicas.
- El responsable asignado a una orden (`assignee`) es una etiqueta (cuadrilla o persona), no una identidad; el actor del ledger sí sale de la sesión.
- Quien tenga acceso al sistema de archivos del servidor puede borrar `auth.json` (reabre la configuración inicial en desarrollo) o leer `seal-key.pem`.
- La foto de cierre se sella pero su contenido no se analiza.
- El modo offline cubre reportes de campo; no hay service worker. Sincronizarlos exige sesión OPERATOR o ADMIN.
