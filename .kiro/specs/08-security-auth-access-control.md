# Especificación 08: Seguridad, autenticación y control de acceso (Fase 2)

Alcance: identidad verificable, permisos por rol aplicados en el servidor, protección de la API y de las operaciones destructivas, y auditoría independiente. Sin servicios externos ni bases de datos: usuarios y sesiones viven en `auth.json` y la auditoría en `audit.jsonl`, ambos junto al estado y fuera de él (reset, demo e import no pueden borrarlos).

## 1. Autenticación y sesiones
- **REQ-AUTH-01**: contraseñas con scrypt nativo (N=2^15, r=8, p=3, sal aleatoria, parámetros guardados por hash), política de longitud y variedad, sin credenciales por defecto ni secretos en el código.
- **REQ-AUTH-02**: sesiones opacas de 256 bits; solo se guarda su SHA-256. Cookie `HttpOnly`, `SameSite=Strict`, `Secure` y prefijo `__Host-` en producción. Caducidad por inactividad (30 min) y absoluta (12 h), cierre de sesión, revocación al desactivar al usuario, cambiar su contraseña o su rol, rotación del identificador en cada login (anti fijación). Usuario y rol se releen del almacén en cada petición.
- **REQ-AUTH-03**: primer administrador con código de un solo uso (160 bits, solo hash, 15 min, 5 intentos) en desarrollo, o con el CLI (`npm run auth`) que es la vía recomendada en producción. El asistente web se cierra de forma definitiva al existir un usuario y en producción está deshabilitado salvo `AQUA_SETUP_ENABLED=1`.
- **REQ-AUTH-04**: CSRF: token derivado de la sesión en cada escritura, token previo a la sesión (doble envío con cookie) para login y configuración inicial, comprobación de `Origin` y `Sec-Fetch-Site`.

## 2. Autorización e identidad
- **REQ-AUTHZ-01**: matriz de permisos VIEWER / OPERATOR / ADMIN (`src/server/authz.ts`) con denegación por defecto: toda ruta de `/api` exige sesión salvo una lista mínima de rutas públicas, y declara el permiso que requiere (una prueba lo comprueba recorriendo las rutas registradas).
- **REQ-AUD-03**: el actor de cada entrada del ledger es el usuario autenticado (id, usuario y rol dentro de `evidenceData`); nombres enviados por el cliente (`reporterName`, `assignee`) se guardan aparte como declarados y no verificados.

## 3. Protección de la API
- **REQ-SEC-03**: límite de tasa en memoria con cupos distintos para autenticación (por IP y por cuenta), IA, fotografías, administración, reautenticación y tráfico general; cuerpos limitados por ruta y leídos después de comprobar sesión y permiso.
- **REQ-SEC-04**: hosts y orígenes permitidos explícitos (obligatorios en producción), anti DNS rebinding, proxys de confianza solo por configuración (`X-Forwarded-*` se ignora si no), CORS cerrado, CSP, `X-Frame-Options`, `Referrer-Policy`, `no-store`.
- **REQ-SEC-05**: reset, demo e import exigen ADMIN, confirmación explícita, token de operación de un solo uso (60 s, ligado a usuario, sesión y operación) obtenido reautenticando con la contraseña, autorización registrada en la auditoría ANTES de ejecutar y copia del estado anterior; si algo de eso falla no se ejecuta.

## 4. Auditoría y resiliencia
- **REQ-AUD-01**: `audit.jsonl` encadenado por hash, cabeza firmada con la clave de sellado, escrituras serializadas con fsync, retoma la cadena si otro proceso escribió. Detecta ediciones, borrados, reordenamientos y truncados de terceros. NO es inmutable frente a quien controla el servidor (puede rehacer cadena y firma) y no rota ni se retiene automáticamente.
- **REQ-AUD-02**: se registran accesos fallidos, denegaciones y escrituras (actor, operación, fecha, resultado, IP); nunca contraseñas, tokens, cookies, claves ni cuerpos. Los usuarios desconocidos se guardan como huella, no en claro.
- **REQ-RES-10**: escritura atómica y cerrojo de archivo en `auth.json`; un fallo de disco rechaza la operación sin dejar estado a medias (el inicio de sesión falla cerrado, las sesiones vivas siguen, la revocación vale en memoria); un `auth.json` corrupto impide arrancar en lugar de reabrir la configuración inicial.

| Requisito | Implementación | Prueba / Verificación |
| --- | --- | --- |
| `REQ-AUTH-01` | `src/server/passwords.ts`, `src/server/authStore.ts` | `src/server/authStore.test.ts` |
| `REQ-AUTH-02` | `src/server/authStore.ts`, `src/server/authApi.ts`, `src/server/netSecurity.ts` | `src/server/security.auth.test.ts`, `src/server/authStore.test.ts` |
| `REQ-AUTH-03` | `src/server/authStore.ts`, `scripts/authAdmin.ts`, `server.ts` | `src/server/security.e2e.test.ts`, `src/server/authStore.test.ts` |
| `REQ-AUTH-04` | `src/server/authApi.ts`, `src/server/netSecurity.ts`, `src/client/api.ts` | `src/server/security.auth.test.ts` |
| `REQ-AUTHZ-01` | `src/server/authz.ts`, `src/server/app.ts`, `src/client/AuthGate.tsx` | `src/server/security.authz.test.ts`, `src/server/netSecurity.test.ts` |
| `REQ-AUD-03` | `src/server/app.ts`, `src/server/authApi.ts` | `src/server/security.authz.test.ts`, `src/server/security.destructive.test.ts` |
| `REQ-SEC-03` | `src/server/rateLimit.ts`, `src/server/authApi.ts` | `src/server/security.auth.test.ts`, `src/server/netSecurity.test.ts` |
| `REQ-SEC-04` | `src/server/netSecurity.ts`, `server.ts` | `src/server/security.auth.test.ts`, `src/server/netSecurity.test.ts`, `src/server/security.e2e.test.ts` |
| `REQ-SEC-05` | `src/server/authApi.ts`, `src/server/operationTokens.ts`, `src/client/adminFetch.ts` | `src/server/security.destructive.test.ts` |
| `REQ-AUD-01` | `src/server/auditLog.ts` | `src/server/auditLog.test.ts`, `src/server/security.destructive.test.ts` |
| `REQ-AUD-02` | `src/server/auditLog.ts`, `src/server/authApi.ts` | `src/server/auditLog.test.ts`, `src/server/security.auth.test.ts`, `src/server/security.e2e.test.ts` |
| `REQ-RES-10` | `src/server/authStore.ts`, `src/server/auditLog.ts` | `src/server/authStore.test.ts`, `src/server/security.destructive.test.ts`, `src/server/security.e2e.test.ts` |
