# Especificación 05: Órdenes de Trabajo, Trust Ledger y Modo Offline

## 1. Órdenes de Trabajo (`SmartWorkOrder`)
- Ciclo de vida: `Abierta` → `En Progreso` → `Cerrada`.
- Campos obligatorios: `id` (`OT-2026-XXX`), `location`, `assetId`, `evidenceIds`, `probableCause`, `priority`, `requiredResources`, `interventionSteps`, `assignee`, `status`, `closureNotes`.

## 2. Trust Ledger Criptográfico (`src/core/cryptoLedger.ts`)
- Estructura append-only con encadenamiento SHA-256 (`Web Crypto SubtleCrypto`).
- No es una blockchain descentralizada; es un ledger auditado verificable localmente y en servidor (`POST /api/ledger/verify`).
- Cada bloque calcula `hash = SHA256(canonical({ id, index, timestamp, action, actor, assetId, previousState, newState, evidenceHash, previousHash }))`.
- `verifyLedgerChain()` valida cada enlace desde el bloque génesis y detecta discrepancias entre cliente y servidor.

## 3. Resiliencia Offline (`src/core/offlineStore.ts`)
- Almacena reportes ciudadanos/técnicos sin conexión en IndexedDB (`aqua-sentinel-db`, objectStore `offline_reports`).
- Deduplicación al sincronizar mediante clave idempotente (`nodeId + category + contentHash + minuteBucket`).
- Al sincronizar, cada reporte no duplicado alimenta anomalías, diagnósticos preliminares, estado del nodo y Trust Ledger.

## 4. Requisitos Formales y Trazabilidad
- **REQ-WO-01**: Gestionar el ciclo `Abierta → En Progreso → Cerrada` registrando cada transición en el Trust Ledger. Al cerrar, el servidor deja el nodo en estado estable con una lectura `restored` que NO es una medición (defecto F2 de la auditoría, pendiente de corregir en el servidor); la interfaz lo muestra como "pendiente de verificación" hasta que existan mediciones posteriores (ver REQ-UX-03).
- **REQ-LED-01**: Ejecutar verificación dual independiente en cliente (Web Crypto) y servidor (`/api/ledger/verify`), alertando alteraciones históricas o discrepancias.
- **REQ-OFF-01**: Escuchar eventos reales de conectividad (`online` / `offline`), almacenar reportes en IndexedDB y sincronizarlos idempotente y efectivamente hacia anomalías y diagnósticos en el servidor.

| Requisito | Implementación | Prueba / Verificación |
| --- | --- | --- |
| `REQ-WO-01` | `server.ts`, `src/components/WorkOrdersView.tsx` | `npm run lint` |
| `REQ-LED-01` | `src/core/cryptoLedger.ts`, `src/components/TrustLedgerView.tsx`, `server.ts` | `src/core/cryptoLedger.test.ts` |
| `REQ-OFF-01` | `src/core/offlineStore.ts`, `src/components/IntegrationsAndOfflineView.tsx`, `src/App.tsx`, `server.ts` | `npm run lint` |

