import { NetworkNode, PipeSegment, ScenarioDefinition, TelemetryReading } from './types';

export const DEMO_PHOTO_ASSETS = {
  leak: '/src/assets/images/incident_pipe_leak_1795035757177.jpg',
  contamination: '/src/assets/images/incident_turbid_water_1795035758691.jpg',
  obstruction: '/src/assets/images/incident_valve_corrosion_1795035758223.jpg',
} as const;

export function createBaselineNodes(): NetworkNode[] {
  const baseTs = '2026-11-18T12:45:00.000Z';

  const specs: Array<Omit<NetworkNode, 'current' | 'status'>> = [
    {
      id: 'N-TOMA-01',
      name: 'Bocatoma Quebrada Alta',
      sector: 'Cuenca Alta',
      kind: 'intake',
      x: 110,
      y: 120,
      elevationM: 1840,
      populationServed: 4800,
      assetCode: 'ACT-TOMA-001',
      material: 'Hormigón Armado + Rejilla Acero',
      diameterMm: 300,
      baseline: {
        pressureBar: 1.4,
        flowLs: 48.0,
        levelPct: 84,
        turbidityNtu: 1.2,
        chlorineMgL: 0.85,
        ph: 7.2,
      },
    },
    {
      id: 'N-PLANTA-02',
      name: 'Planta Filtración Comunitaria',
      sector: 'Cuenca Alta',
      kind: 'pump',
      x: 270,
      y: 125,
      elevationM: 1795,
      populationServed: 4800,
      assetCode: 'ACT-PTAP-002',
      material: 'Acero Dúctil',
      diameterMm: 250,
      baseline: {
        pressureBar: 4.1,
        flowLs: 46.5,
        levelPct: 79,
        turbidityNtu: 0.6,
        chlorineMgL: 1.05,
        ph: 7.1,
      },
    },
    {
      id: 'N-TANQ-03',
      name: 'Tanque Elevado Mirador',
      sector: 'Cota Superior',
      x: 455,
      y: 95,
      kind: 'tank',
      elevationM: 1865,
      populationServed: 4800,
      assetCode: 'ACT-RES-003',
      material: 'Concreto Pretensado 450 m³',
      diameterMm: 250,
      baseline: {
        pressureBar: 3.6,
        flowLs: 45.2,
        levelPct: 82,
        turbidityNtu: 0.5,
        chlorineMgL: 0.95,
        ph: 7.2,
      },
    },
    {
      id: 'N-TRON-04',
      name: 'Troncal Sector Norte',
      sector: 'Sector Norte',
      kind: 'junction',
      x: 635,
      y: 110,
      elevationM: 1853.3,
      populationServed: 1950,
      assetCode: 'ACT-PVC-204',
      material: 'PVC Presión PN10',
      diameterMm: 200,
      baseline: {
        pressureBar: 4.5,
        flowLs: 22.8,
        levelPct: 0,
        turbidityNtu: 0.5,
        chlorineMgL: 0.9,
        ph: 7.2,
      },
    },
    {
      id: 'N-VALV-05',
      name: 'Cámara Válvula Sur',
      sector: 'Sector Sur',
      kind: 'valve',
      x: 470,
      y: 255,
      elevationM: 1853.8,
      populationServed: 1750,
      assetCode: 'ACT-VALV-055',
      material: 'Hierro Fundido Bridado',
      diameterMm: 150,
      baseline: {
        pressureBar: 4.2,
        flowLs: 18.4,
        levelPct: 0,
        turbidityNtu: 0.6,
        chlorineMgL: 0.88,
        ph: 7.2,
      },
    },
    {
      id: 'N-DIST-06',
      name: 'Red Escolar y Centro Salud',
      sector: 'Centro Cívico',
      kind: 'distribution',
      x: 785,
      y: 165,
      elevationM: 1848.7,
      populationServed: 1420,
      assetCode: 'ACT-DIST-061',
      material: 'HDPE PE100',
      diameterMm: 110,
      baseline: {
        pressureBar: 3.9,
        flowLs: 14.2,
        levelPct: 0,
        turbidityNtu: 0.5,
        chlorineMgL: 0.82,
        ph: 7.2,
      },
    },
    {
      id: 'N-DIST-07',
      name: 'Ramal Barrio La Esperanza',
      sector: 'Sector Sur',
      kind: 'distribution',
      x: 665,
      y: 295,
      elevationM: 1850.4,
      populationServed: 1100,
      assetCode: 'ACT-DIST-074',
      material: 'PVC PN10',
      diameterMm: 110,
      baseline: {
        pressureBar: 3.7,
        flowLs: 11.6,
        levelPct: 0,
        turbidityNtu: 0.6,
        chlorineMgL: 0.8,
        ph: 7.3,
      },
    },
  ];

  return specs.map((spec) => ({
    ...spec,
    status: 'nominal',
    current: {
      id: `READ-${spec.id}-0`,
      timestamp: baseTs,
      nodeId: spec.id,
      ...spec.baseline,
      synthetic: true,
    },
  }));
}

export const NETWORK_PIPES: PipeSegment[] = [
  {
    id: 'P-01',
    from: 'N-TOMA-01',
    to: 'N-PLANTA-02',
    diameterMm: 300,
    lengthM: 640,
    material: 'Acero Dúctil',
    status: 'nominal',
  },
  {
    id: 'P-02',
    from: 'N-PLANTA-02',
    to: 'N-TANQ-03',
    diameterMm: 250,
    lengthM: 820,
    material: 'Acero Dúctil',
    status: 'nominal',
  },
  {
    id: 'P-03',
    from: 'N-TANQ-03',
    to: 'N-TRON-04',
    diameterMm: 200,
    lengthM: 950,
    material: 'PVC PN10',
    status: 'nominal',
  },
  {
    id: 'P-04',
    from: 'N-TANQ-03',
    to: 'N-VALV-05',
    diameterMm: 150,
    lengthM: 710,
    material: 'Hierro Dúctil',
    status: 'nominal',
  },
  {
    id: 'P-05',
    from: 'N-TRON-04',
    to: 'N-DIST-06',
    diameterMm: 110,
    lengthM: 540,
    material: 'HDPE PE100',
    status: 'nominal',
  },
  {
    id: 'P-06',
    from: 'N-VALV-05',
    to: 'N-DIST-07',
    diameterMm: 110,
    lengthM: 620,
    material: 'PVC PN10',
    status: 'nominal',
  },
];

/**
 * Metadatos de los 4 escenarios de la demostración. Las LECTURAS que los materializan NO viven aquí:
 * las genera src/sim/scenarioGenerator.ts con un solver hidráulico y entran por la ingesta como cualquier dato,
 * de modo que el motor de diagnóstico no sabe qué escenario es (REQ-HYD-04).
 */
export const DIFFERENTIAL_SCENARIOS: ScenarioDefinition[] = [
  {
    id: 'leak',
    label: '1. Fuga en Troncal',
    shortTitle: 'Pérdida de caudal en el tramo Troncal Norte → Centro Cívico',
    nodeId: 'N-TRON-04',
    category: 'leak',
    summary:
      'Rotura sintética de 12 L/s (a presión nominal) generada por un solver hidráulico. El balance de masa entre los medidores N-TRON-04 y N-DIST-06 y la respuesta de presión del tramo aguas arriba permiten concluir con incertidumbre explícita. Una fotografía de apoyo solo cuenta si un proveedor de visión la analiza.',
    imageUrl: DEMO_PHOTO_ASSETS.leak,
    imageTitle: 'Inspección cámara Troncal Sector Norte (fotografía de demostración)',
  },
  {
    id: 'obstruction',
    label: '2. Obstrucción Válvula',
    shortTitle: 'Obstrucción progresiva en Válvula Sur',
    nodeId: 'N-VALV-05',
    category: 'obstruction',
    summary:
      'Reducción severa de caudal acompañada de sobrepresión previa en Cámara Válvula Sur (lectura sintética de demostración).',
    imageUrl: DEMO_PHOTO_ASSETS.obstruction,
    imageTitle: 'Cámara Válvula Sur (fotografía de demostración)',
  },
  {
    id: 'sensor_fault',
    label: '3. Falla de Sensor',
    shortTitle: 'Lectura físicamente inconsistente en Tanque Mirador',
    nodeId: 'N-TANQ-03',
    category: 'sensor_fault',
    summary:
      'El nodo reporta turbidez negativa y caudal cero mientras mantiene presión alta sin cierre de válvula (lectura sintética de demostración).',
  },
  {
    id: 'contamination',
    label: '4. Posible Contaminación',
    shortTitle: 'Anomalía de calidad en Bocatoma',
    nodeId: 'N-TOMA-01',
    category: 'contamination',
    summary:
      'Turbidez y cloro libre fuera de rango en Bocatoma Quebrada Alta (lectura sintética de demostración). Una fotografía solo cuenta si un proveedor de visión la analiza.',
    imageUrl: DEMO_PHOTO_ASSETS.contamination,
    imageTitle: 'Reporte en Bocatoma Quebrada Alta (fotografía de demostración)',
  },
];

export function generateBaselineSeries(node: NetworkNode, points = 16): TelemetryReading[] {
  const now = Date.now();
  const series: TelemetryReading[] = [];
  for (let i = points - 1; i >= 0; i--) {
    const ts = new Date(now - i * 5 * 60 * 1000).toISOString();
    const wave = Math.sin((points - i) * 0.55);
    series.push({
      id: `HIST-${node.id}-${i}`,
      timestamp: ts,
      nodeId: node.id,
      pressureBar: Number((node.baseline.pressureBar + wave * 0.09).toFixed(2)),
      flowLs: Number((node.baseline.flowLs + wave * 0.6).toFixed(2)),
      levelPct: node.baseline.levelPct > 0 ? Number((node.baseline.levelPct + wave * 1.5).toFixed(1)) : 0,
      turbidityNtu: Number(Math.max(0.2, node.baseline.turbidityNtu + wave * 0.06).toFixed(2)),
      chlorineMgL: Number(Math.max(0.1, node.baseline.chlorineMgL + wave * 0.03).toFixed(2)),
      ph: Number((node.baseline.ph + wave * 0.05).toFixed(2)),
      synthetic: true,
    });
  }
  return series;
}

export const SAMPLE_CSV_PAYLOAD = `timestamp,nodeId,pressureBar,flowLs,levelPct,turbidityNtu,chlorineMgL,ph
2026-11-18T12:50:00Z,N-TOMA-01,1.42,48.5,84,1.3,0.84,7.2
2026-11-18T12:55:00Z,N-TRON-04,2.58,29.8,0,0.7,0.85,7.2
2026-11-18T12:56:00Z,N-VALV-05,5.34,8.1,0,0.9,0.80,7.3
2026-11-18T12:58:00Z,N-TOMA-01,1.46,52.0,88,15.1,0.15,6.1`;
