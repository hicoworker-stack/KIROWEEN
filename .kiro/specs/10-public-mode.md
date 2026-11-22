# Especificación 10: Modo público de demostración y video explicativo

Objetivo: que cualquier persona (usuarios, instituciones, aliados, jurados) abra la URL y explore Aqua Sentinel sin iniciar sesión ni registrarse, sin debilitar la autenticación, los roles, las sesiones, el CSRF ni las autorizaciones del servidor.

## 1. Diseño
- **Explícito y reversible**: solo con `AQUA_PUBLIC_MODE=1` (o `--public`, `npm run public`). Sin la variable, toda ruta exige sesión, como antes.
- **Solo lectura, lista cerrada**: un visitante anónimo supera únicamente `GET /api/state`, `GET /api/events` y `GET /api/evidence/:sha256`, con el rol `VISITOR` (`state:read` y `evidence:read`). No existe en `auth.json`, no tiene sesión y nunca se le trata como operador ni administrador. Toda escritura, la IA, los expedientes, los snapshots, los usuarios, la auditoría y `/api/kiro/files` siguen exigiendo sesión, CSRF y el permiso del rol.
- **Datos aislados y simulados**: estado propio en `data/public-demo/`; el servidor se niega a arrancar si el estado contiene lecturas no sintéticas; `AQUA_FIELD_DATA` se ignora; el asistente de primer administrador queda deshabilitado.
- **Estado redactado**: el visitante recibe el estado sin rutas de disco ni mensajes internos. El ledger se entrega íntegro, porque redactarlo rompería su cadena de hashes.
- **Sembrado con la API real**: al arrancar sin estrenar se ejecuta el flujo (fuga, decisión, orden en curso con tareas y foto) con la cuenta interna `demo.seed` (OPERATOR, contraseña aleatoria sin guardar, desactivada al terminar). Pasa por los mismos permisos, CSRF, ledger y auditoría que cualquier usuario.
- **Interfaz**: menú desplegable único (Inicio, Mapa, Incidentes, Órdenes de trabajo, herramientas avanzadas y sesión); aviso permanente de modo público; Inicio con presentación (título, video 16:9, cómo funciona y acceso) para visitantes y presentación plegada para quien tiene sesión.
- **Video**: archivo local en `public/videos/` configurable en `public/config/intro-video.json`; portada en `public/images/`; sin archivo muestra «Video explicativo próximamente» y no simula reproducción; sin autoplay.

## 2. Requisitos
- **REQ-PUB-01**: El modo público admite visitantes anónimos solo en tres rutas GET de lectura; cualquier otra ruta o método sigue exigiendo sesión, CSRF y permiso. Es explícito y reversible, y las rutas públicas y protegidas están documentadas.
- **REQ-PUB-02**: La instancia pública sirve únicamente datos sintéticos de un estado aislado, redactados para visitantes, sembrados con la API real, y se niega a arrancar con lecturas de campo.
- **REQ-PUB-03**: El video explicativo es configurable por archivo, validado, bajo demanda y nunca simulado; la CSP solo permite video del propio servidor u orígenes https autorizados.
- **REQ-PUB-05**: El Hero ofrece un selector English / Español (inglés por defecto) que cambia sin recargar su título, su subtítulo y su video. Cada idioma muestra solo su propia versión del video; si un idioma no la tiene, se avisa en ese idioma y nunca se usa la de otro. Al cambiar de idioma el video anterior se detiene y desaparece, de modo que nunca suenan dos.
- **REQ-PUB-04**: La navegación es un menú desplegable accesible y la pantalla de Inicio presenta título, video, flujo CAPTURA → DETECCIÓN → ANÁLISIS → ACCIÓN → VERIFICACIÓN y acceso a la plataforma, sin ofrecer al visitante acciones que no puede usar.

## 3. Limitaciones declaradas
- Quien inicie sesión en una instancia pública deja su nombre visible para los visitantes en el registro de la demostración.
- Los visitantes comparten el cupo anónimo por IP; detrás de un proxy sin `AQUA_TRUSTED_PROXIES` todos comparten una.
- La verificación de la cadena en el servidor requiere sesión; el visitante dispone de la verificación local.
- La versión inglesa del video es una animación ilustrativa (sin grabación de la aplicación, cuya interfaz está en español); la española incluye la grabación real. Solo el Hero cambia de idioma; el resto de la plataforma sigue en español.
- El video de Inicio es una grabación real de la aplicación con datos simulados, precedida de una animación ilustrativa y narrada con voz sintética; no es un video institucional ni muestra imágenes de campo.
- F1, F2 y F3 de la auditoría están corregidos en el servidor (spec 11).

| Requisito | Implementación | Prueba / Verificación |
| --- | --- | --- |
| `REQ-PUB-01` | `src/server/publicMode.ts`, `src/server/authApi.ts`, `src/server/authz.ts`, `src/core/permissions.ts` | `src/server/security.public.test.ts`, `src/server/netSecurity.test.ts` |
| `REQ-PUB-02` | `src/server/publicMode.ts`, `src/server/publicDemo.ts`, `src/server/app.ts`, `server.ts`, `src/server/cliFlags.ts` | `src/server/security.public.test.ts` |
| `REQ-PUB-03` | `src/ui/introVideo.ts`, `src/components/IntroSection.tsx`, `src/server/netSecurity.ts` | `src/ui/introVideo.test.ts`, `src/ui/views.test.tsx`, `src/server/netSecurity.test.ts` |
| `REQ-PUB-05` | `src/ui/heroCopy.ts`, `src/ui/introVideo.ts`, `src/components/IntroSection.tsx`, `public/config/intro-video.json` | `src/ui/introVideo.test.ts`, `src/ui/views.test.tsx` |
| `REQ-PUB-04` | `src/components/AppShell.tsx`, `src/components/HomeView.tsx`, `src/components/IntroSection.tsx`, `src/client/AuthGate.tsx`, `src/App.tsx` | `src/ui/views.test.tsx` |
