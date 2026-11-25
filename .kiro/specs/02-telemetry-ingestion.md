# Especificación 02: Ingesta de Telemetría (CSV + Simulador IoT)

## 1. Contrato de Datos (`TelemetryReading`)
- `id`: identificador único de lectura
- `timestamp`: ISO-8601 UTC
- `nodeId`: identificador válido dentro del grafo de red (`T-01`, `B-01`, `V-01`, `N-01`, etc.)
- `pressureBar`: presión hidráulica en bar (`0.0` a `12.0` rango físico nominal)
- `flowLs`: caudal volumétrico en L/s (`>= 0.0`)
- `levelPct`: porcentaje de llenado en tanques (`0.0` a `100.0`)
- `turbidityNtu`: turbidez en NTU (`>= 0.0`)
- `chlorineMgL`: cloro libre residual en mg/L (`>= 0.0`)
- `ph`: potencial de hidrógeno (`0.0` a `14.0`)
- `valveState` (opcional): `'open' | 'closed' | 'throttled'` para contextualizar cierres operativos programados
- `synthetic`: booleano obligatorio (`true` para todo dato de demostración o simulador)

## 2. Requisitos Formales y Trazabilidad
- **REQ-ING-01**: Toda lectura `TelemetryReading` DEBE declarar explícitamente `synthetic` y aceptar `valveState` opcional sin romper compatibilidad CSV de 8 columnas.
- **REQ-ING-02**: `parseCsvTelemetry()` DEBE validar cabecera obligatoria `timestamp,nodeId,pressureBar,flowLs,levelPct,turbidityNtu,chlorineMgL,ph`, rechazar `NaN` o columnas faltantes y reportar errores por línea sin abortar filas válidas.
- **REQ-ING-03**: La ruta `POST /api/telemetry/ingest` DEBE evaluar anomalías, enriquecerlas con contexto hidráulico de red y registrar auditoría en el Trust Ledger.

| Requisito | Implementación | Prueba / Verificación |
| --- | --- | --- |
| `REQ-ING-01` | `src/core/types.ts`, `src/core/telemetryValidation.ts` | `src/core/telemetryValidation.test.ts` |
| `REQ-ING-02` | `src/core/deterministicEngine.ts` | `src/core/deterministicEngine.test.ts` |
| `REQ-ING-03` | `server.ts`, `src/core/graphHydrology.ts` | `src/core/graphHydrology.test.ts` |

