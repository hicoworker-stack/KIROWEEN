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


## Interfaz

Cuatro apartados: **Inicio** (estado de la red y qué hacer ahora), **Mapa**, **Incidentes** (qué pasa, qué significa y qué hacer) y **Órdenes de trabajo**. Las herramientas técnicas (series de sensores, evidencia visual, Trust Ledger, conexión e integraciones, demostración) están en **Herramientas avanzadas**, desde el menú de usuario.

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
