import {
  AnomalyCategory,
  AnomalyEvent,
  CsvParseResult,
  DeterministicRuleHit,
  NetworkNode,
  PriorityBreakdown,
  PriorityLevel,
  ScenarioId,
  TelemetryReading,
} from './types';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pctDelta(current: number, baseline: number): number {
  if (Math.abs(baseline) < 0.0001) {
    return current === 0 ? 0 : 100;
  }
  return Number((((current - baseline) / Math.abs(baseline)) * 100).toFixed(1));
}

export function evaluateTelemetryReading(
  reading: TelemetryReading,
  node: NetworkNode,
  history: TelemetryReading[] = []
): AnomalyEvent | null {
  const baseline = node.baseline;
  const hits: DeterministicRuleHit[] = [];

  // R3: Physical implausibility & frozen sensor check runs FIRST
  const hasNegativeReading =
    reading.turbidityNtu < 0 ||
    reading.pressureBar < 0 ||
    reading.flowLs < 0 ||
    reading.chlorineMgL < 0;
  const hasOutOfBounds =
    reading.pressureBar > 15 || reading.ph < 2 || reading.ph > 12 || reading.levelPct > 100;
  const isValveClosed = reading.valveState === 'closed';
  const zeroFlowWithHighPressure =
    !isValveClosed && reading.flowLs < 0.2 && baseline.flowLs > 5 && reading.pressureBar > 3.5;

  const lastReading = history.length > 0 ? history[history.length - 1] : null;
  const suddenImpossibleSpike =
    !isValveClosed &&
    lastReading !== null &&
    Math.abs(reading.pressureBar - lastReading.pressureBar) > 4.2 &&
    Math.abs(reading.flowLs - lastReading.flowLs) > baseline.flowLs * 0.9;

  if (hasNegativeReading || hasOutOfBounds || zeroFlowWithHighPressure || suddenImpossibleSpike) {
    const metric =
      reading.turbidityNtu < 0
        ? 'turbidityNtu'
        : zeroFlowWithHighPressure
          ? 'flowLs'
          : 'pressureBar';
    const observedValue =
      metric === 'turbidityNtu'
        ? reading.turbidityNtu
        : metric === 'flowLs'
          ? reading.flowLs
          : reading.pressureBar;
    const baseValue =
      metric === 'turbidityNtu'
        ? baseline.turbidityNtu
        : metric === 'flowLs'
          ? baseline.flowLs
          : baseline.pressureBar;

    hits.push({
      ruleId: 'SENSOR_PHYSICAL_IMPLAUSIBILITY',
      title: 'Inconsistencia física de telemetría (probable falla de sensor)',
      category: 'sensor_fault',
      severityScore: 68,
      metric,
      observedValue,
      baselineValue: baseValue,
      deltaPct: pctDelta(observedValue, baseValue),
      explanation: hasNegativeReading
        ? `Valor físico imposible detectado (${metric} = ${observedValue}). Un transductor calibrado no puede emitir magnitudes negativas.`
        : zeroFlowWithHighPressure
          ? `Caudal nulo (${reading.flowLs} L/s) coexistiendo con presión elevada (${reading.pressureBar} bar) con válvula abierta.`
          : `Lectura fuera de rango físico operativo o salto instantáneo incompatible con inercia hidráulica.`,
    });
  }

  // R3b: Frozen sensor (stuck-at-value) over 4 consecutive readings
  if (history.length >= 3) {
    const window4 = [...history.slice(-3), reading];
    const allEqual = (picker: (r: TelemetryReading) => number) =>
      window4.every((item) => item !== undefined && picker(item) === picker(window4[0]));

    if (
      allEqual((r) => r.pressureBar) &&
      allEqual((r) => r.flowLs) &&
      allEqual((r) => r.turbidityNtu) &&
      allEqual((r) => r.chlorineMgL)
    ) {
      hits.push({
        ruleId: 'SENSOR_STUCK_AT_VALUE',
        title: 'Sensor congelado sin varianza física (stuck-at-value)',
        category: 'sensor_fault',
        severityScore: 64,
        metric: 'pressureBar',
        observedValue: reading.pressureBar,
        baselineValue: baseline.pressureBar,
        deltaPct: pctDelta(reading.pressureBar, baseline.pressureBar),
        explanation: `Se detectaron ${window4.length} lecturas consecutivas exactamente idénticas (${reading.pressureBar} bar, ${reading.flowLs} L/s, ${reading.turbidityNtu} NTU, ${reading.chlorineMgL} mg/L), patrón típico de buffer Modbus/ADC congelado.`,
      });
    }
  }

  // R1: Hydraulic pressure drop + flow surge -> Leak
  const pressureDropPct = pctDelta(reading.pressureBar, baseline.pressureBar);
  const flowChangePct = pctDelta(reading.flowLs, baseline.flowLs);

  if (!isValveClosed && reading.pressureBar >= 0 && pressureDropPct <= -22) {
    const flowEvidenceBoost = flowChangePct >= 15 ? 20 : 0;
    hits.push({
      ruleId: 'PRESSURE_DROP_LEAK',
      title: 'Caída crítica de presión compatible con fuga activa',
      category: 'leak',
      severityScore: clamp(Math.round(Math.abs(pressureDropPct) * 1.65 + flowEvidenceBoost), 45, 96),
      metric: 'pressureBar',
      observedValue: reading.pressureBar,
      baselineValue: baseline.pressureBar,
      deltaPct: pressureDropPct,
      explanation: `Presión cayó ${Math.abs(pressureDropPct)}% (${reading.pressureBar} bar vs ${baseline.pressureBar} bar base)${
        flowChangePct >= 15
          ? ` con aumento simultáneo de caudal (+${flowChangePct}%), patrón hidráulico característico de rotura o fuga en troncal.`
          : '.'
      }`,
    });
  }

  // R2: Progressive flow reduction + upstream backpressure -> Obstruction (skip if valve intentionally closed)
  if (!isValveClosed && reading.flowLs > 0.2 && flowChangePct <= -30 && pressureDropPct >= 12) {
    hits.push({
      ruleId: 'FLOW_OBSTRUCTION',
      title: 'Reducción severa de caudal con sobrepresión previa (obstrucción)',
      category: 'obstruction',
      severityScore: clamp(Math.round(Math.abs(flowChangePct) * 1.35 + pressureDropPct * 0.6), 50, 92),
      metric: 'flowLs',
      observedValue: reading.flowLs,
      baselineValue: baseline.flowLs,
      deltaPct: flowChangePct,
      explanation: `Caudal descendió ${Math.abs(flowChangePct)}% (${reading.flowLs} L/s vs ${baseline.flowLs} L/s base) mientras la presión subió +${pressureDropPct}% (${reading.pressureBar} bar), indicando estrangulamiento u obstrucción en válvula/tramo.`,
    });
  }

  // R4: Water quality parameters threshold exceedance (distinguish drift vs contamination risk)
  const highTurbidity = reading.turbidityNtu > 4.0;
  const veryLowChlorine = reading.chlorineMgL >= 0 && reading.chlorineMgL < 0.2;
  const lowChlorine = reading.chlorineMgL >= 0 && reading.chlorineMgL < 0.3;
  const excessChlorine = reading.chlorineMgL > 2.5;
  const outOfRangePh = reading.ph >= 2 && reading.ph <= 12 && (reading.ph < 6.5 || reading.ph > 8.5);
  const severePh = reading.ph >= 2 && reading.ph <= 12 && (reading.ph < 6.0 || reading.ph > 9.0);

  if (highTurbidity || lowChlorine || excessChlorine || outOfRangePh) {
    const isContaminationRisk =
      highTurbidity || veryLowChlorine || excessChlorine || severePh || (lowChlorine && outOfRangePh);

    const category: AnomalyCategory = isContaminationRisk ? 'contamination' : 'quality_drift';
    const turbidityDelta = pctDelta(reading.turbidityNtu, baseline.turbidityNtu);
    const severity = isContaminationRisk
      ? clamp((highTurbidity ? 45 : 0) + (lowChlorine ? 30 : 0) + (outOfRangePh ? 15 : 0) + (excessChlorine ? 40 : 0), 58, 98)
      : 44;

    hits.push({
      ruleId: 'QUALITY_PARAMETER_ANOMALY',
      title: isContaminationRisk
        ? 'Desviación múltiple o severa de parámetros de calidad (riesgo sanitario)'
        : 'Deriva operativa de desinfectante / pH (sin turbidez asociada)',
      category,
      severityScore: severity,
      metric: highTurbidity ? 'turbidityNtu' : lowChlorine || excessChlorine ? 'chlorineMgL' : 'ph',
      observedValue: highTurbidity
        ? reading.turbidityNtu
        : lowChlorine || excessChlorine
          ? reading.chlorineMgL
          : reading.ph,
      baselineValue: highTurbidity
        ? baseline.turbidityNtu
        : lowChlorine || excessChlorine
          ? baseline.chlorineMgL
          : baseline.ph,
      deltaPct: highTurbidity
        ? turbidityDelta
        : lowChlorine || excessChlorine
          ? pctDelta(reading.chlorineMgL, baseline.chlorineMgL)
          : pctDelta(reading.ph, baseline.ph),
      explanation: isContaminationRisk
        ? `Parámetros fuera de rango operativo seguro: ${
            highTurbidity ? `turbidez ${reading.turbidityNtu} NTU (>4.0 NTU)` : ''
          }${highTurbidity && lowChlorine ? ', ' : ''}${
            lowChlorine ? `cloro residual ${reading.chlorineMgL} mg/L (<0.30 mg/L)` : ''
          }${excessChlorine ? `cloro excesivo ${reading.chlorineMgL} mg/L (>2.5 mg/L)` : ''}${
            outOfRangePh ? `, pH ${reading.ph} (fuera de 6.5–8.5)` : ''
          }. Requiere muestreo confirmatorio.`
        : `Deriva moderada detectada sin turbidez elevada (${reading.turbidityNtu} NTU): ${
            lowChlorine ? `cloro residual ${reading.chlorineMgL} mg/L (0.20–0.29 mg/L)` : ''
          }${outOfRangePh ? `${lowChlorine ? ', ' : ''}pH ${reading.ph}` : ''}. Verificar dosificación antes de escalar.`,
    });
  }

  if (hits.length === 0) {
    return null;
  }

  // Dominant category: prioritize physical implausibility / stuck sensor over derived hydraulic/quality hits
  const primaryHit = selectPrimaryHit(hits, reading);

  const priority = computeRiskPriorityScore({
    category: primaryHit.category,
    maxRuleSeverity: primaryHit.severityScore,
    populationServed: node.populationServed,
    ruleCount: hits.length,
  });

  const scenarioMap: Partial<Record<AnomalyCategory, ScenarioId>> = {
    leak: 'leak',
    obstruction: 'obstruction',
    sensor_fault: 'sensor_fault',
    contamination: 'contamination',
  };

  return {
    id: `ANOM-${node.id}-${Date.now().toString(36).toUpperCase()}`,
    timestamp: reading.timestamp,
    nodeId: node.id,
    nodeName: node.name,
    sector: node.sector,
    category: primaryHit.category,
    title: primaryHit.title,
    status: 'active',
    rulesTriggered: hits,
    priority,
    telemetrySnapshot: reading,
    baselineSnapshot: baseline,
    scenarioId: scenarioMap[primaryHit.category],
    synthetic: reading.synthetic,
  };
}

/**
 * Arbitraje de categoría dominante (REQ-DET-04).
 * 1. Fallas de sensor siempre dominan (la lectura no es confiable).
 * 2. Fuga confirmada por presión + anomalía de calidad:
 *    - turbidez > 4 NTU: domina contaminación (hipótesis de intrusión por baja presión); la fuga se conserva como evidencia.
 *    - solo cloro/pH: domina la fuga; la deriva queda como evidencia secundaria.
 *    Así el piso de severidad de calidad (58) no oculta fugas pequeñas.
 * 3. En el resto domina la mayor severidad.
 */
export function selectPrimaryHit(
  hits: DeterministicRuleHit[],
  reading: Pick<TelemetryReading, 'turbidityNtu'>
): DeterministicRuleHit {
  const sensor =
    hits.find((h) => h.ruleId === 'SENSOR_PHYSICAL_IMPLAUSIBILITY') ??
    hits.find((h) => h.ruleId === 'SENSOR_STUCK_AT_VALUE');
  if (sensor) return sensor;

  const leak = hits.find((h) => h.ruleId === 'PRESSURE_DROP_LEAK');
  const quality = hits.find((h) => h.ruleId === 'QUALITY_PARAMETER_ANOMALY');
  if (leak && quality) {
    return reading.turbidityNtu > 4.0 ? quality : leak;
  }
  return [...hits].sort((a, b) => b.severityScore - a.severityScore)[0];
}

export function computeRiskPriorityScore(input: {
  category: AnomalyCategory;
  maxRuleSeverity: number;
  populationServed: number;
  ruleCount: number;
}): PriorityBreakdown {
  const hydraulicWeight = clamp(input.maxRuleSeverity * 0.4, 0, 40);
  const populationFactor = clamp(input.populationServed / 5000, 0.15, 1) * 30;
  const qualityWeight =
    input.category === 'contamination'
      ? 20
      : input.category === 'quality_drift'
        ? 12
        : input.category === 'leak'
          ? 12
          : input.category === 'obstruction'
            ? 10
            : 4;
  const evidenceWeight = clamp(input.ruleCount * 5, 5, 10);

  const totalScore = Math.round(
    clamp(hydraulicWeight + populationFactor + qualityWeight + evidenceWeight, 0, 100)
  );

  let priority: PriorityLevel = 'Baja';
  if (totalScore >= 80) priority = 'Crítica';
  else if (totalScore >= 60) priority = 'Alta';
  else if (totalScore >= 35) priority = 'Media';

  return {
    totalScore,
    priority,
    hydraulicWeight: Number(hydraulicWeight.toFixed(1)),
    populationWeight: Number(populationFactor.toFixed(1)),
    qualityWeight,
    evidenceWeight,
    formulaNote:
      '0.40 × Severidad Hidráulica + 0.30 × Población Expuesta + 0.20 × Riesgo Sanitario + 0.10 × Reglas Correlacionadas',
  };
}

export const MAX_CSV_ROWS = 5000;

export function parseCsvTelemetry(csvText: string): CsvParseResult {
  const lines = csvText
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return {
      readings: [],
      errors: ['El archivo CSV debe contener cabecera y al menos una fila de mediciones.'],
      rowCount: 0,
    };
  }

  const expectedHeaders = [
    'timestamp',
    'nodeId',
    'pressureBar',
    'flowLs',
    'levelPct',
    'turbidityNtu',
    'chlorineMgL',
    'ph',
  ];
  const headers = lines[0].split(',').map((h) => h.trim());
  const missingHeaders = expectedHeaders.filter((h) => !headers.includes(h));

  if (missingHeaders.length > 0) {
    return {
      readings: [],
      errors: [`Cabeceras obligatorias faltantes: ${missingHeaders.join(', ')}`],
      rowCount: lines.length - 1,
    };
  }

  if (lines.length - 1 > MAX_CSV_ROWS) {
    return {
      readings: [],
      errors: [`El CSV tiene ${lines.length - 1} filas; el máximo es ${MAX_CSV_ROWS}.`],
      rowCount: lines.length - 1,
    };
  }

  const indexOf = (col: string) => headers.indexOf(col);
  const readings: TelemetryReading[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim());
    if (cols.length < expectedHeaders.length) {
      errors.push(`Fila ${i + 1}: número insuficiente de columnas.`);
      continue;
    }

    const timestamp = cols[indexOf('timestamp')];
    const nodeId = cols[indexOf('nodeId')];
    const pressureBar = Number(cols[indexOf('pressureBar')]);
    const flowLs = Number(cols[indexOf('flowLs')]);
    const levelPct = Number(cols[indexOf('levelPct')]);
    const turbidityNtu = Number(cols[indexOf('turbidityNtu')]);
    const chlorineMgL = Number(cols[indexOf('chlorineMgL')]);
    const ph = Number(cols[indexOf('ph')]);

    const numericCells = [pressureBar, flowLs, levelPct, turbidityNtu, chlorineMgL, ph];
    const emptyCell = ['pressureBar', 'flowLs', 'levelPct', 'turbidityNtu', 'chlorineMgL', 'ph'].some(
      (col) => cols[indexOf(col)] === ''
    );
    if (
      !timestamp ||
      !nodeId ||
      emptyCell ||
      !Number.isFinite(Date.parse(timestamp)) ||
      numericCells.some((n) => !Number.isFinite(n))
    ) {
      errors.push(`Fila ${i + 1}: valores numéricos no finitos, fecha inválida o campos vacíos.`);
      continue;
    }

    const valveIdx = indexOf('valveState');
    const rawValve = valveIdx !== -1 ? cols[valveIdx] : undefined;
    const valveState =
      rawValve === 'closed' || rawValve === 'throttled' || rawValve === 'open'
        ? rawValve
        : undefined;

    readings.push({
      id: `CSV-${nodeId}-${i}-${Date.now().toString(36)}`,
      timestamp,
      nodeId,
      pressureBar,
      flowLs,
      levelPct,
      turbidityNtu,
      chlorineMgL,
      ph,
      ...(valveState ? { valveState } : {}),
      synthetic: true,
      source: 'csv',
    });
  }

  return {
    readings,
    errors,
    rowCount: lines.length - 1,
  };
}



