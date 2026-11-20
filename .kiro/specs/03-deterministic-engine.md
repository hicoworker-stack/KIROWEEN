# Especificación 03: Motor Determinista de Detección, Scoring e Hidrología de Grafo

## 1. Reglas Físicas y Estadísticas (`evaluateTelemetryReading`)
1. **R1 — Fuga Hidráulica (`PRESSURE_DROP_LEAK`)**:
   - Caída de presión $\ge 22\%$ respecto a línea base histórica del nodo.
   - Evidencia adicional si el caudal aguas arriba aumenta o diverge $\ge 15\%$ frente al caudal esperado.
2. **R2 — Obstrucción Progresiva (`FLOW_OBSTRUCTION`)**:
   - Reducción de caudal $\ge 30\%$ bajo línea base acompañada de incremento de contrapresión $\ge 12\%$.
3. **R3 — Falla Física de Sensor (`SENSOR_PHYSICAL_IMPLAUSIBILITY` / `SENSOR_STUCK_AT_VALUE`)**:
   - Lecturas físicamente imposibles (`turbidityNtu < 0`, `pressureBar < 0`, `pressureBar > 15`, `ph < 2 || ph > 12`), caudal nulo (`< 0.2 L/s`) simultáneo a presión elevada (`> 3.5 bar`) cuando `valveState !== 'closed'`, o salto instantáneo $> 3.5\sigma$.
   - Señal congelada (`SENSOR_STUCK_AT_VALUE`): 4 lecturas consecutivas con varianza nula en presión, caudal y turbidez.
4. **R4 — Calidad del Agua (`QUALITY_PARAMETER_ANOMALY` y `quality_drift`)**:
   - Severa (`contamination`): `turbidityNtu > 4.0`, `chlorineMgL < 0.20`, `chlorineMgL > 2.5`, o `ph < 6.5 || ph > 8.5`.
   - Deriva menor (`quality_drift`): `chlorineMgL` entre `0.20` y `0.30` o `pH` en banda marginal sin turbidez elevada.

## 2. Topología e Hidrología de Grafo (`src/core/graphHydrology.ts`)
- Cálculo de nodos aguas arriba/abajo (BFS dirigido sobre `NETWORK_PIPES`).
- Evaluación de balance de masa nodal (`HYDRAULIC_MASS_IMBALANCE`) entre caudal entrante, saliente y demanda esperada.
- Propagación de riesgo aguas abajo excepto cuando la categoría origen es `sensor_fault`.

## 3. Requisitos Formales y Trazabilidad
- **REQ-DET-01**: Detectar `PRESSURE_DROP_LEAK`, `FLOW_OBSTRUCTION`, `SENSOR_PHYSICAL_IMPLAUSIBILITY` y `QUALITY_PARAMETER_ANOMALY` de forma determinista y sin IA.
- **REQ-DET-02**: Suprimir falsos positivos de caudal nulo con presión alta cuando `valveState === 'closed'`, detectar `SENSOR_STUCK_AT_VALUE` (4 lecturas idénticas) y diferenciar `quality_drift` de `contamination`.
- **REQ-DET-03**: Calcular `computeRiskPriorityScore` en el rango `[0, 100]` clasificando `Crítica` ($\ge 80$), `Alta` ($60\text{--}79$), `Media` ($35\text{--}59$) y `Baja` ($< 35$).
- **REQ-HYD-01**: Propagar riesgo aguas abajo y evaluar desbalance hidráulico nodal sobre el grafo `NETWORK_PIPES`, reflejando nodos/tuberías afectadas en `NetworkMap` y `MapView`.

| Requisito | Implementación | Prueba / Verificación |
| --- | --- | --- |
| `REQ-DET-01` | `src/core/deterministicEngine.ts` | `src/core/deterministicEngine.test.ts` |
| `REQ-DET-02` | `src/core/deterministicEngine.ts` | `src/core/deterministicEngine.test.ts` |
| `REQ-DET-03` | `src/core/deterministicEngine.ts` | `src/core/deterministicEngine.test.ts` |
| `REQ-HYD-01` | `src/core/graphHydrology.ts`, `src/components/NetworkMap.tsx`, `src/components/HomeView.tsx` | `src/core/graphHydrology.test.ts` |

