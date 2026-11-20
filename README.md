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

## Variables de entorno

| Variable | Efecto |
| --- | --- |
| `GEMINI_API_KEY` | Opcional. Habilita análisis de imagen y redacción del diagnóstico con Gemini. Sin clave, todo el flujo crítico sigue con el adaptador determinista, declarado en la interfaz. |
| `GEMINI_MODEL` | Modelo a usar. El valor por defecto `gemini-2.5-flash` **no está validado con clave real** y, según la documentación de Google, es un modelo heredado que se redirigirá desde el 2026-12-01. Fija y valida el modelo antes de depender de él. |
| `GEMINI_TIMEOUT_MS` / `GEMINI_TOTAL_BUDGET_MS` | Tiempo por llamada (15000) y presupuesto total por enriquecimiento (30000). |
| `AQUA_ADMIN_TOKEN` | Si existe, `reset`, `demo` e `import` exigen la cabecera `X-Admin-Token`. |
| `AQUA_ALLOW_DESTRUCTIVE=1` | Permite esas operaciones sin token (en producción están deshabilitadas por defecto). Fuera de producción se permiten solo desde loopback. |
| `AQUA_FIELD_DATA=1` | Permite que la telemetría externa se marque como dato de campo; por defecto toda lectura externa se fuerza a sintética. |
| `AQUA_SEAL_PRIVATE_KEY_PEM` | Clave Ed25519 de sellado. Si falta, se usa `seal-key.pem` junto al estado o una clave efímera que se declara como tal. |
| `AQUA_STATE_PATH`, `HOST`, `PORT` | Ubicación del estado persistido y red. |

Las operaciones destructivas exigen además `X-Aqua-Confirm: <reset|demo|import>` y archivan el estado previo en `backups/`.

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

## Seguridad: lo que falta

- Fuera de las operaciones destructivas, la API no tiene autenticación de usuarios; el actor de cada acción se registra como "declarado, sin autenticar".
- No hay limitación de tasa de peticiones.
- La foto de cierre se sella pero su contenido no se analiza.
- El modo offline cubre reportes de campo; no hay service worker.
