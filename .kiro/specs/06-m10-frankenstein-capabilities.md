# Especificación 06: M-10, Forense Hidráulica, Concordancia Multimodal, Expediente Verificable y Modo Demo
## 1. Órdenes de trabajo M-10
- Checklist derivado de `interventionSteps`; cada ítem marcado registra actor y hora en el Trust Ledger.
- Responsable reasignable mientras la orden no esté cerrada (`WORK_ORDER_ASSIGNED`).
- Foto de cierre (JPEG/PNG/WebP, máx. 6 MB) guardada por contenido (SHA-256) y sellada (`CLOSURE_EVIDENCE_ATTACHED`).
- Cierre rechazado con HTTP 409 si falta checklist completo o foto. Al cerrar se sella una huella de la orden (`orderDigest`).
- Series temporales de `levelPct` y `ph` en Sensores; `levelPct` solo en nodos con sensor de nivel.
## 2. Capacidades que nacen de la interacción de tecnologías
- **Diagnóstico hidráulico** (`src/core/hydraulicDiagnosis.ts`, reemplaza a la antigua forense circular): balance de masa por tramo con incertidumbre propagada de los medidores, persistencia de 2 muestras y corroboración por presión contra la pérdida de carga predicha. Niveles: datos insuficientes / sin anomalía / anomalía de caudal / posible fuga / fuga localizada. Resolución limitada al tramo entre dos medidores; el caudal perdido es estimación con su σ.
- **Concordancia multimodal** (`src/core/evidenceConcordance.ts`): sensores, hidráulica y fotografía se evalúan por separado y producen un nivel de respaldo (baja/media/alta/en_conflicto), sin porcentajes. La foto solo cuenta si un proveedor real la analizó y está vinculada a ese incidente; un conflicto se reporta, nunca se promedia.
- **Expediente verificable** (`src/core/dossier.ts`, `scripts/verifyDossier.ts`): formato `aqua-sentinel-dossier/2` con contenido congelado al cierre (orden, anomalía, telemetría, diagnóstico, visión, hidráulica, evidencia), huella por componente, recibo firmado Ed25519 y ancla externa. La verificación separa integridad, autenticidad (requiere clave fijada) e inmutabilidad (nunca garantizada).
## 3. Honestidad de proveedores y persistencia
- Gemini: modelo configurable (`GEMINI_MODEL`); el valor por defecto `gemini-2.5-flash` NO está validado con clave real y figura como heredado en la documentación de Google. Reintento ante 429/5xx, presupuesto total de tiempo, respuestas validadas por esquema, sonda `POST /api/ai/probe`. Sin clave o ante fallo se usa el adaptador determinista y se declara.
- La visión de respaldo no analiza píxeles ni clasifica por nombre/ruta/URL: devuelve "no analizada". Solo un proveedor real (Gemini con clave) puede analizar la imagen.
- Persistencia: archivo local (`AQUA_STATE_PATH`), riesgo efímero informado en `/api/health`, snapshot exportable/importable que valida la cadena antes de aceptar (`src/server/snapshot.ts`).
- Adaptadores AWS (S3, Lambda, DynamoDB) son SIMULADOS; Bedrock no está configurado.
## 4. Requisitos Formales y Trazabilidad
- **REQ-DET-04**: Arbitrar leak vs calidad: la deriva de cloro/pH no oculta una fuga; turbidez > 4 NTU con caída de presión escala a contaminación conservando la regla de fuga.
- **REQ-WO-02**: Checklist interactivo y asignación de responsable persistidos y registrados en el ledger.
- **REQ-WO-03**: Evidencia fotográfica de cierre validada, direccionada por SHA-256 y obligatoria para cerrar.
- **REQ-HYD-02**: Localizar el tramo sospechoso y estimar la pérdida con el balance de masa, declarando incertidumbre; ver REQ-HYD-03..06 en la especificación 07.
- **REQ-AI-07**: Reportar la concordancia entre canales como nivel de respaldo (sin porcentaje) y marcar conflicto cuando los canales se contradicen.
- **REQ-AI-08**: Estado Gemini honesto (modelo, verificación real, errores) y visión de respaldo sin interpretar fotos no empaquetadas.
- **REQ-LED-02**: Entradas del ledger con `evidenceData` cubiertas por el hash; expediente portable verificable offline (ver REQ-LED-03..07).
- **REQ-PER-02**: Informar riesgo de persistencia efímera y permitir snapshot verificado.
- **REQ-DEMO-01**: Modo demo reproducible (`POST /api/demo/frankenstein`) con datos sintéticos rotulados, sin servicios externos.
| Requisito | Implementación | Prueba / Verificación |
| --- | --- | --- |
| `REQ-DET-04` | `src/core/deterministicEngine.ts` | `src/core/deterministicEngine.test.ts` |
| `REQ-WO-02` | `src/core/workOrders.ts`, `src/components/WorkOrdersView.tsx`, `server.ts` | `src/core/workOrders.test.ts`, `src/server/e2e.test.ts` |
| `REQ-WO-03` | `src/server/evidenceStore.ts`, `src/core/workOrders.ts`, `server.ts` | `src/server/evidenceStore.test.ts`, `src/server/e2e.test.ts` |
| `REQ-HYD-02` | `src/core/hydraulicDiagnosis.ts`, `src/components/EvidencePanels.tsx` | `src/core/hydraulicDiagnosis.test.ts` |
| `REQ-AI-07` | `src/core/evidenceConcordance.ts`, `src/components/EvidencePanels.tsx` | `src/core/evidenceConcordance.test.ts` |
| `REQ-AI-08` | `src/server/aiProvider.ts`, `src/components/OperationsHealthPanel.tsx` | `src/server/aiProvider.test.ts`, `src/server/e2e.test.ts` |
| `REQ-LED-02` | `src/core/cryptoLedger.ts`, `src/core/dossier.ts`, `scripts/verifyDossier.ts` | `src/core/cryptoLedger.test.ts`, `src/server/e2e.test.ts` |
| `REQ-PER-02` | `src/server/snapshot.ts`, `src/components/OperationsHealthPanel.tsx` | `src/server/snapshot.test.ts` |
| `REQ-DEMO-01` | `server.ts`, `src/App.tsx` | `src/server/e2e.test.ts` |
