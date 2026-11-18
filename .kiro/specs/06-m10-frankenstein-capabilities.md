# Especificación 06: M-10, Forense Hidráulica, Concordancia Multimodal, Expediente Verificable y Modo Demo
## 1. Órdenes de trabajo M-10
- Checklist derivado de `interventionSteps`; cada ítem marcado registra actor y hora en el Trust Ledger.
- Responsable reasignable mientras la orden no esté cerrada (`WORK_ORDER_ASSIGNED`).
- Foto de cierre (JPEG/PNG/WebP, máx. 6 MB) guardada por contenido (SHA-256) y sellada (`CLOSURE_EVIDENCE_ATTACHED`).
- Cierre rechazado con HTTP 409 si falta checklist completo o foto. Al cerrar se sella una huella de la orden (`orderDigest`).
- Series temporales de `levelPct` y `ph` en Sensores; `levelPct` solo en nodos con sensor de nivel.
## 2. Capacidades que nacen de la interacción de tecnologías
- **Forense hidráulica** (`src/core/leakForensics.ts`): balance de masa entre medidores + déficit de presión + foto ubican el tramo sospechoso y estiman L/s y m³/día. Resolución limitada al tramo entre dos medidores; el caudal es estimación, no medición.
- **Concordancia multimodal** (`src/core/evidenceConcordance.ts`): sensores, foto y topología votan por separado; un conflicto limita la confianza al 55%, solo sensores al 70%.
- **Expediente verificable** (`src/core/dossier.ts`, `scripts/verifyDossier.ts`): JSON portable con cadena, foto y huella de la orden, verificable offline. Prueba integridad, no autoría (no es firma digital).
## 3. Honestidad de proveedores y persistencia
- Gemini: modelo configurable (`GEMINI_MODEL`, por defecto `gemini-2.5-flash`), reintento ante 429/5xx, sonda `POST /api/ai/probe`. Sin clave o ante fallo se usa el adaptador determinista y se declara.
- La visión de respaldo no analiza píxeles: solo las imágenes de demostración empaquetadas tienen anotación predefinida y se rotula como tal.
- Persistencia: archivo local (`AQUA_STATE_PATH`), riesgo efímero informado en `/api/health`, snapshot exportable/importable que valida la cadena antes de aceptar (`src/server/snapshot.ts`).
- Adaptadores AWS (S3, Lambda, DynamoDB) son SIMULADOS; Bedrock no está configurado.
## 4. Requisitos Formales y Trazabilidad
- **REQ-DET-04**: Arbitrar leak vs calidad: la deriva de cloro/pH no oculta una fuga; turbidez > 4 NTU con caída de presión escala a contaminación conservando la regla de fuga.
- **REQ-WO-02**: Checklist interactivo y asignación de responsable persistidos y registrados en el ledger.
- **REQ-WO-03**: Evidencia fotográfica de cierre validada, direccionada por SHA-256 y obligatoria para cerrar.
- **REQ-HYD-02**: Localizar tramo sospechoso y estimar pérdida a partir del balance de masa, sin afirmar certeza que los medidores no dan.
- **REQ-AI-02**: Reportar concordancia entre canales y limitar la confianza calibrada ante conflicto o evidencia única.
- **REQ-AI-03**: Estado Gemini honesto (modelo, verificación real, errores) y visión de respaldo sin interpretar fotos no empaquetadas.
- **REQ-LED-02**: Entradas del ledger con `evidenceData` verificable y expediente portable verificable offline.
- **REQ-PER-02**: Informar riesgo de persistencia efímera y permitir snapshot verificado.
- **REQ-DEMO-01**: Modo demo reproducible (`POST /api/demo/frankenstein`) con datos sintéticos rotulados, sin servicios externos.
| Requisito | Implementación | Prueba / Verificación |
| --- | --- | --- |
| `REQ-DET-04` | `src/core/deterministicEngine.ts` | `src/core/deterministicEngine.test.ts` |
| `REQ-WO-02` | `src/core/workOrders.ts`, `src/components/WorkOrdersView.tsx`, `server.ts` | `src/core/workOrders.test.ts`, `src/server/e2e.test.ts` |
| `REQ-WO-03` | `src/server/evidenceStore.ts`, `src/core/workOrders.ts`, `server.ts` | `src/server/evidenceStore.test.ts`, `src/server/e2e.test.ts` |
| `REQ-HYD-02` | `src/core/leakForensics.ts`, `src/components/EvidencePanels.tsx` | `src/core/leakForensics.test.ts` |
| `REQ-AI-02` | `src/core/evidenceConcordance.ts`, `src/components/EvidencePanels.tsx` | `src/core/evidenceConcordance.test.ts` |
| `REQ-AI-03` | `src/server/aiProvider.ts`, `src/components/OperationsHealthPanel.tsx` | `src/server/aiProvider.test.ts`, `src/server/e2e.test.ts` |
| `REQ-LED-02` | `src/core/cryptoLedger.ts`, `src/core/dossier.ts`, `scripts/verifyDossier.ts` | `src/core/cryptoLedger.test.ts`, `src/server/e2e.test.ts` |
| `REQ-PER-02` | `src/server/snapshot.ts`, `src/components/OperationsHealthPanel.tsx` | `src/server/snapshot.test.ts` |
| `REQ-DEMO-01` | `server.ts`, `src/App.tsx` | `src/server/e2e.test.ts` |
