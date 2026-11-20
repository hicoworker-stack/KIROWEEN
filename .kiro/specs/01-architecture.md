# Especificación 01: Arquitectura Frankenstein de Aqua Sentinel

## 1. Propósito
Integrar seis disciplinas operativas tradicionalmente aisladas en un único ciclo cerrado de decisión hídrica auditable:
`Dato → Anomalía → Correlación → Diagnóstico → Decisión → Orden de Trabajo → Verificación`.

## 2. Capas Integradas
1. **IoT & Ingesta de Telemetría** (`src/core/deterministicEngine.ts`): Series temporales de presión (bar), caudal (L/s), nivel de almacenamiento (%), turbidez (NTU), cloro residual (mg/L) y pH.
2. **Visión Artificial Multimodal** (`src/server/aiProvider.ts`): Inspección de fotografías de campo mediante `@google/genai` con separación estricta entre observación visual, inferencia operativa e incertidumbre.
3. **Geointeligencia Hidráulica** (`src/core/networkData.ts`, `src/core/graphHydrology.ts`, `src/components/NetworkMap.tsx`): Topología de red comunitaria (tomas, tanques, bombeo, válvulas, nodos de distribución), balance de masa y propagación aguas abajo.
4. **Motor Determinista Independiente** (`src/core/deterministicEngine.ts`): Reglas físicas, detección de sensor congelado y puntuación de riesgos sin dependencia de LLM.
5. **Aqua Brain (Agente Híbrido)** (`src/components/IncidentsView.tsx`, `server.ts`): Correlación multi-evidencia, enriquecimiento asíncrono por SSE, hipótesis alternativas y aprobación humana.
6. **Trust Ledger Criptográfico** (`src/core/cryptoLedger.ts`, `src/server/persistence.ts`): Registro append-only con encadenamiento SHA-256 verificable, persistencia en disco y resiliencia offline en IndexedDB (`src/core/offlineStore.ts`).

## 3. Requisitos Formales y Trazabilidad
- **REQ-ARCH-01**: El sistema DEBE cerrar el ciclo operativo completo desde la detección determinista hasta el cierre verificado en el Trust Ledger.
- **REQ-ARCH-02**: El motor determinista DEBE ejecutarse en milisegundos sin bloquear el hilo HTTP por llamadas LLM; el enriquecimiento Gemini se difiere asíncronamente por SSE (`/api/events`).
- **REQ-ARCH-03**: El estado operativo completo (nodos, series, anomalías, análisis visuales, diagnósticos, órdenes y ledger) DEBE persistir de forma atómica en disco ante reinicios del servidor.

| Requisito | Implementación | Prueba / Verificación |
| --- | --- | --- |
| `REQ-ARCH-01` | `server.ts`, `src/App.tsx`, `src/core/types.ts` | `npm run lint` |
| `REQ-ARCH-02` | `server.ts`, `src/core/deterministicEngine.ts`, `src/server/aiProvider.ts` | `src/server/aiProvider.test.ts` |
| `REQ-ARCH-03` | `src/server/persistence.ts`, `server.ts` | `src/server/persistence.test.ts` |

