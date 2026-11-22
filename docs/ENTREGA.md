# Aqua Sentinel: entrega para Kiroween 2026

## En una frase
Aqua Sentinel une sensores, fotos, reportes de campo, un modelo hidráulico y un registro criptográfico para que una red comunitaria de agua pase de una anomalía a una reparación comprobada con mediciones, y dice en cada paso qué está medido, qué es inferido y qué es simulado.

## El ensamblaje Frankenstein
Piezas que normalmente viven separadas, cosidas en un solo flujo:

| Pieza | Qué aporta | Dónde |
| --- | --- | --- |
| Telemetría IoT (presión, caudal, calidad) | Lecturas validadas e idempotentes | `src/core/telemetryValidation.ts` |
| Motor determinista | Reglas físicas, sin IA | `src/core/deterministicEngine.ts` |
| Modelo hidráulico | Balance de masa por tramo, contrastado con EPANET | `src/core/graphHydrology.ts`, `src/sim/hydraulicModel.ts` |
| Visión (Gemini, opcional) | Foto como evidencia solo si se analizó de verdad | `src/server/aiProvider.ts` |
| Reportes sin conexión | La palabra de una persona, rotulada como DECLARADA | `/api/sync/offline` |
| Trust Ledger | Cadena SHA-256 y expediente sellado con firma local | `src/core/ledger.ts`, `src/core/dossier.ts` |
| Órdenes de trabajo | Cierre con tareas completas, foto sellada y medición posterior | `src/server/app.ts` |

## Cómo se usó Kiro
**specs → requisitos → pruebas → `verify:kiro`.** Cada una de las 11 especificaciones de `.kiro/specs/` declara requisitos `REQ-*` con una tabla de trazabilidad hacia el código y sus pruebas. `npm run verify:kiro` falla si un requisito no tiene implementación o prueba, o si una prueba queda fuera del hook de integridad. Las 23 reglas de `.kiro/steering/` fijan el criterio del dominio (por ejemplo «sin recuperación sin medición» o «nada se simula en silencio») y las pruebas las hacen cumplir.

Estado al entregar: 71 requisitos trazados, 393 pruebas `node:test` en verde, `tsc --noEmit` y `vite build` limpios, `npm audit --omit=dev` sin vulnerabilidades.

## Video de demostración
El Hero tiene un selector English / Español (inglés por defecto) y cada idioma reproduce solo su versión:
- **English**: `public/videos/aqua-sentinel-demo-en.mp4` (2 min 12 s, subtítulos `aqua-sentinel-demo-en.vtt`). Es una animación ilustrativa del mismo flujo, con todos los textos, la narración (voz sintética Zira, en-US) y los subtítulos en inglés.
- **Español**: `public/videos/aqua-sentinel-demo.mp4` (2 min 20 s, subtítulos `aqua-sentinel-demo.vtt`), descrito abajo.

- Empieza con 16,5 s de animación ilustrativa y sigue con la **grabación real** de la aplicación sobre una instancia local con datos simulados.
- La narración es una **voz sintética** de Windows (Sabina, es-MX).
- La foto de cierre que aparece es una imagen ilustrativa rotulada «SIMULADA», no una fotografía de campo.
- La medición posterior al cierre también es simulada, y así lo dice la narración.

| Tiempo | Qué se ve |
| --- | --- |
| 0:00 | Animación: gota, red, fuga, análisis, orden y sello |
| 0:17 | Inicio y mapa: la red está estable, con datos rotulados SIMULADO |
| 0:28 | Se lanza el escenario «Fuga en Troncal» |
| 0:38 | El incidente: reglas, balance hidráulico y nivel de respaldo sin porcentajes |
| 0:52 | Procedencia de cada dato; la foto vinculada consta como «no analizada» |
| 1:07 | Una persona acepta la recomendación y se crea la orden |
| 1:16 | Se inicia la intervención y se marcan las tareas |
| 1:25 | Foto de cierre sellada con SHA-256 y cierre de la orden |
| 1:34 | El punto queda «pendiente de verificación», sin recuperación supuesta |
| 1:44 | Llega una medición posterior: recuperación medida y registrada en el ledger |
| 1:54 | Trust Ledger: cadena verificada y entrada `POST_CLOSURE_MEASUREMENT` |
| 2:07 | Cierre: «de la anomalía a una acción verificable», hecho con Kiro |

## Guion para presentarlo en vivo (3 minutos)
1. **Problema (20 s).** Las redes comunitarias pierden agua por fugas que nadie ve, y cuando se repara algo nadie comprueba con datos que se arregló.
2. **Entrada (10 s).** Abrir la URL: se entra directo, sin cuenta, en modo de solo lectura.
3. **Detección (40 s).** Incidentes: mostrar el balance hidráulico, el tramo candidato P-05 y el nivel de respaldo «Medio» explicado con palabras.
4. **Honestidad (30 s).** Señalar las etiquetas MEDIDO, INFERIDO y SIMULADO, y la foto «sin analizar».
5. **Acción (40 s).** Órdenes: tareas, foto sellada y, tras el cierre, «pendiente de verificación» hasta que llegue una medición.
6. **Prueba (30 s).** Trust Ledger: verificar la cadena en el navegador.
7. **Kiro (10 s).** Specs → requisitos → pruebas → `verify:kiro`.

## Qué es real y qué no
- **Real:** el código, las reglas, el modelo hidráulico, la cadena de hashes, la autenticación y los permisos, y las 393 pruebas.
- **Simulado:** todos los datos de la red San Cristóbal de las Aguas y la medición posterior del video.
- **Sin validar:** Gemini (texto y visión), porque no hay clave configurada. La plataforma funciona entera sin ella.
- **No se afirma:** ningún ahorro real de agua ni ninguna certificación sanitaria.

## Publicar la URL pública
La instancia pública es solo lectura y siembra su propia demostración al arrancar (spec 10).

### Opción A: Render (recomendada, gratis)
1. Sube el repositorio a GitHub.
2. En Render: **New → Blueprint** y elige el repositorio. Render lee `render.yaml` y construye el `Dockerfile`.
3. Cuando Render asigne el dominio, pon en `AQUA_ALLOWED_HOSTS` el dominio (`aqua-sentinel-xxxx.onrender.com`) y en `AQUA_ALLOWED_ORIGINS` su versión `https://`. Sin esas dos variables el servidor no arranca en producción, a propósito.
4. Comprueba que `https://<dominio>/api/health` responde `{"ok":true,"authRequired":false,"publicMode":true}`.

En el plan gratuito el disco es efímero y el servicio se duerme sin tráfico: al despertar vuelve a sembrar la demostración. Para entrar como operador en esa instancia, crea un administrador desde la consola del servicio: `npm run auth -- create-admin <usuario> --public`.

### Opción B: túnel temporal desde tu equipo (no probada)
Con `npm run public` en marcha, un túnel (por ejemplo `cloudflared tunnel --url http://localhost:3000`) da una URL https mientras tu equipo esté encendido. Hay que añadir el dominio del túnel a `AQUA_ALLOWED_HOSTS` y `AQUA_ALLOWED_ORIGINS`, y puede que también a la lista de hosts de Vite en modo desarrollo. Mientras dure, expone tu máquina a Internet: el modo público sigue siendo de solo lectura, pero conviene cerrarlo al terminar.
