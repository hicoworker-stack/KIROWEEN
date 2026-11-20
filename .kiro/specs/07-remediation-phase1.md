# Especificación 07: Remediación Fase 1 (integridad, ledger, IA, hidráulica)

Cada requisito nace de un hallazgo de la auditoría adversarial. Todo dato de la red *San Cristóbal de las Aguas* es sintético. Las integraciones con Gemini real no están validadas con credenciales reales.

## 1. Seguridad y resiliencia
- **REQ-SEC-01**: `reset`, `demo` e `import` exigen cabecera `X-Aqua-Confirm` con el nombre de la operación (anti-CSRF) y, si existe `AQUA_ADMIN_TOKEN`, `X-Admin-Token`. Sin token solo se permiten con `AQUA_ALLOW_DESTRUCTIVE=1` o fuera de producción por loopback; si no, 403. El estado anterior se archiva en `backups/` y su cabeza se registra en el nuevo génesis.
- **REQ-SEC-02**: ninguna ruta de imagen proveniente de la petición se lee del disco sin validar; las imágenes subidas se validan por firma real.
- **REQ-RES-01**: validación estricta de telemetría (números finitos, rangos estructurales, fechas, nodos conocidos, límite de filas CSV).
- **REQ-RES-02**: un estado persistido malformado se repara o descarta sin dejar la interfaz en blanco.
- **REQ-RES-03**: un reporte offline solo reemplaza a una anomalía si el cierre es posterior; los reenvíos son idempotentes.
- **REQ-RES-04**: las actualizaciones concurrentes de órdenes se serializan (Mutex FIFO) sin pérdida de cambios.
- **REQ-RES-05**: un fallo de escritura en disco no tumba el servidor; se informa "solo memoria" y se recupera solo.
- **REQ-RES-06**: los errores asíncronos de Express no terminan el proceso.
- **REQ-RES-07**: deduplicación de lecturas por `nodeId|timestamp`; datos externos siempre marcados sintéticos salvo `AQUA_FIELD_DATA=1`.
- **REQ-RES-08**: un `ErrorBoundary` evita la pantalla en blanco ante datos inesperados (verificado por compilación y tipado; sin prueba automática de navegador).
- **REQ-RES-09**: tras un reset el snapshot archivado se restaura con orden, foto y expediente verificables.

## 2. Trust Ledger
- **REQ-LED-03**: al cerrar una orden se congela y sella el expediente completo (anomalía, telemetría, diagnóstico, visión, hidráulica, orden, evidencia) con huella por componente.
- **REQ-LED-04**: las mutaciones del ledger son atómicas y ordenadas.
- **REQ-LED-05**: la verificación distingue integridad, autenticidad (clave fijada por el verificador) e inmutabilidad (nunca garantizada). Un expediente fabricado con cadena válida no es auténtico.
- **REQ-LED-06**: coherencia entre órdenes, diagnósticos y ledger comprobada al consultar y exportar.
- **REQ-LED-07**: un snapshot se rechaza si no coincide con su ledger o si la cadena o un expediente sellado fue alterado.

## 3. IA y visión
- **REQ-AI-03**: respuestas de Gemini validadas por esquema; vacías, malformadas o con tipos incorrectos activan el respaldo determinista (`invalid_response`).
- **REQ-AI-04**: presupuesto total de tiempo; nunca queda un enriquecimiento pendiente para siempre; la visión no clasifica por nombre, ruta ni URL.
- **REQ-AI-05**: cada foto se vincula a su incidente; no se reutiliza evidencia de otro incidente.
- **REQ-AI-06**: una respuesta tardía de un estado anterior se descarta (control de época) y no genera entradas fantasma en el ledger.

## 4. Hidráulica
- **REQ-HYD-03**: diagnóstico con incertidumbre propagada, tolerancia de sincronía, datos insuficientes explícitos y niveles anomalía de caudal / posible fuga / fuga localizada.
- **REQ-HYD-04**: el solver y el generador de escenarios (`src/sim/`) son independientes del detector; no se importan desde `src/core/`.
- **REQ-HYD-05**: el solver se contrasta con EPANET (`epanet-js`, WASM) y las discrepancias máximas quedan acotadas por tolerancias.
- **REQ-HYD-06**: evaluación Monte Carlo con verdad de terreno: falsos positivos, sensibilidad y localización, con límites de detección declarados.

## 5. Arquitectura y demo
- **REQ-ARCH-04**: la lógica pura permanece en `src/core/` sin importar `src/server/`, `src/sim/` ni React.

| Requisito | Implementación | Prueba / Verificación |
| --- | --- | --- |
| `REQ-SEC-01` | `src/server/http.ts`, `src/server/app.ts`, `src/client/adminFetch.ts` | `src/server/http.test.ts`, `src/server/e2e.test.ts` |
| `REQ-SEC-02` | `src/server/aiProvider.ts`, `src/server/evidenceStore.ts` | `src/server/aiProvider.test.ts`, `src/server/e2e.test.ts` |
| `REQ-RES-01` | `src/core/telemetryValidation.ts`, `src/core/deterministicEngine.ts` | `src/core/telemetryValidation.test.ts`, `src/server/e2e.test.ts` |
| `REQ-RES-02` | `src/core/stateRepair.ts`, `src/server/persistence.ts` | `src/core/stateRepair.test.ts`, `src/server/persistence.test.ts` |
| `REQ-RES-03` | `src/core/offlineConflict.ts`, `src/server/app.ts` | `src/core/offlineConflict.test.ts`, `src/server/e2e.test.ts` |
| `REQ-RES-04` | `src/server/runtime.ts`, `src/server/app.ts` | `src/server/runtime.test.ts`, `src/server/e2e.test.ts` |
| `REQ-RES-05` | `src/server/runtime.ts`, `src/server/persistence.ts` | `src/server/runtime.test.ts`, `src/server/e2e.test.ts` |
| `REQ-RES-06` | `src/server/http.ts`, `server.ts` | `src/server/http.test.ts`, `src/server/e2e.test.ts` |
| `REQ-RES-07` | `src/core/telemetryValidation.ts`, `src/server/app.ts` | `src/core/telemetryValidation.test.ts`, `src/server/e2e.test.ts` |
| `REQ-RES-08` | `src/components/ErrorBoundary.tsx`, `src/main.tsx` | `src/architecture.test.ts` |
| `REQ-RES-09` | `src/server/snapshot.ts`, `src/server/app.ts` | `src/server/e2e.test.ts` |
| `REQ-LED-03` | `src/core/dossier.ts`, `src/server/dossierService.ts` | `src/server/dossier.test.ts`, `src/server/e2e.test.ts` |
| `REQ-LED-04` | `src/server/runtime.ts` | `src/server/runtime.test.ts` |
| `REQ-LED-05` | `src/server/sealing.ts`, `src/server/dossierVerify.ts`, `scripts/verifyDossier.ts` | `src/server/sealing.test.ts`, `src/server/dossier.test.ts` |
| `REQ-LED-06` | `src/core/consistency.ts` | `src/core/consistency.test.ts` |
| `REQ-LED-07` | `src/server/snapshot.ts` | `src/server/snapshot.test.ts`, `src/server/e2e.test.ts` |
| `REQ-AI-03` | `src/server/llmSchemas.ts`, `src/server/aiProvider.ts` | `src/server/llmSchemas.test.ts`, `src/server/aiProvider.test.ts`, `src/server/e2e.ai.test.ts` |
| `REQ-AI-04` | `src/server/aiProvider.ts`, `src/core/evidenceLinking.ts` | `src/server/aiProvider.test.ts`, `src/server/e2e.ai.test.ts` |
| `REQ-AI-05` | `src/core/evidenceLinking.ts`, `src/server/app.ts` | `src/core/evidenceLinking.test.ts`, `src/server/e2e.test.ts` |
| `REQ-AI-06` | `src/server/app.ts` | `src/server/e2e.ai.test.ts` |
| `REQ-HYD-03` | `src/core/hydraulicDiagnosis.ts`, `src/core/graphHydrology.ts` | `src/core/hydraulicDiagnosis.test.ts`, `src/core/graphHydrology.test.ts` |
| `REQ-HYD-04` | `src/sim/hydraulicModel.ts`, `src/sim/scenarioGenerator.ts` | `src/sim/hydraulicModel.test.ts`, `src/architecture.test.ts` |
| `REQ-HYD-05` | `src/sim/hydraulicModel.ts` | `src/sim/epanetValidation.test.ts` |
| `REQ-HYD-06` | `src/sim/evaluation.ts` | `src/sim/evaluation.test.ts` |
| `REQ-ARCH-04` | `src/core/types.ts` | `src/architecture.test.ts` |
| `REQ-DEMO-01` | `src/server/app.ts`, `src/App.tsx` | `src/server/e2e.test.ts`, `src/server/e2e.ai.test.ts` |
