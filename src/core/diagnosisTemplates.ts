import { ConcordanceReport, EVIDENCE_LEVEL_LABEL, HydraulicEvidence } from './evidenceConcordance';
import { visionRoleForAnomaly } from './evidenceLinking';
import { AlternativeHypothesis, AnomalyEvent, AquaBrainDiagnosis, NetworkNode, VisionAnalysisResult } from './types';

/**
 * REQ-AI-03: cuerpo del diagnóstico determinista (sin red, sin LLM).
 * Todo texto se deriva de los datos del incidente. No hay cifras fijas de un escenario ni afirmaciones sobre el contenido
 * de una fotografía que no haya sido analizada (defectos de la versión anterior).
 */

export interface DiagnosisContext {
  anomaly: AnomalyEvent;
  node: NetworkNode;
  /** Solo la fotografía ya vinculada a ESTE incidente. */
  vision?: VisionAnalysisResult | null;
  hydraulic?: (HydraulicEvidence & { estimatedLossM3PerDay?: number; reachLabels?: string[] }) | null;
  concordance?: ConcordanceReport | null;
}

export type DiagnosisBody = Omit<
  AquaBrainDiagnosis,
  'id' | 'anomalyId' | 'timestamp' | 'nodeId' | 'nodeName' | 'operatorDecision' | 'providerUsed' | 'providerMode' | 'enrichmentStatus' | 'fallbackReason' | 'visionAnalysisId'
>;

const hab = (n: number) => n.toLocaleString('es-ES');

function evidenceList(ctx: DiagnosisContext): string[] {
  const { anomaly, node, vision, hydraulic } = ctx;
  const items: string[] = [
    ...anomaly.rulesTriggered.map((r) => r.explanation),
    `Topología: ${node.name} abastece a ${hab(node.populationServed)} habitantes en ${node.sector}.`,
  ];
  if (anomaly.downstreamAffectedNodeIds && anomaly.downstreamAffectedNodeIds.length > 0) {
    items.push(
      `Propagación en el grafo: ${anomaly.downstreamAffectedNodeIds.length} nodo(s) aguas abajo expuestos (${anomaly.downstreamAffectedNodeIds.join(', ')}); población potencialmente impactada: ${hab(anomaly.downstreamPopulationAffected ?? node.populationServed)} hab.`
    );
  }
  if (hydraulic && (hydraulic.level === 'possible_leak' || hydraulic.level === 'localized_leak')) {
    items.push(
      `Balance hidráulico: exceso de caudal de ${hydraulic.excessLs ?? '?'} L/s (±${hydraulic.sigmaLs ?? '?'}) con respuesta de presión coherente (${hydraulic.level === 'localized_leak' ? 'fuga localizada' : 'posible fuga'}).`
    );
  }
  if (vision) {
    const role = visionRoleForAnomaly(vision, anomaly);
    if (role === 'not_analyzed') {
      items.push('Fotografía vinculada al incidente pero NO analizada por ningún proveedor de visión: no se usa como evidencia.');
    } else {
      const observed = vision.observed.slice(0, 2).join('; ');
      items.push(
        `Evidencia visual analizada por ${vision.providerUsed}: categoría "${vision.visualCategory}" (${role === 'confirmatory' ? 'confirma' : role === 'contradictory' ? 'contradice' : 'no concluyente'} frente a "${anomaly.category}")${observed ? `. Observado: ${observed}` : ''}.`
      );
    }
  }
  return items;
}

function photoNote(ctx: DiagnosisContext, ifContradictsAlt: string): string {
  const role = ctx.vision ? visionRoleForAnomaly(ctx.vision, ctx.anomaly) : 'not_analyzed';
  if (role === 'contradictory') return 'Una fotografía analizada sugiere otra categoría: contradice esta hipótesis.';
  if (role === 'confirmatory') return 'Una fotografía analizada es compatible con la hipótesis principal.';
  return ifContradictsAlt;
}

export function buildDeterministicDiagnosisBody(ctx: DiagnosisContext): DiagnosisBody {
  const { anomaly, node } = ctx;
  const base = {
    availableEvidences: evidenceList(ctx),
    priority: anomaly.priority.priority,
    priorityScore: anomaly.priority.totalScore,
    evidenceLevel: ctx.concordance?.level ?? ('baja' as const),
    evidenceBasis: ctx.concordance?.basis ?? [anomaly.origin === 'offline-report' ? 'reporte' : 'sensores'],
  };

  if (anomaly.category === 'leak') return leakBody(ctx, base);

  if (anomaly.category === 'obstruction') {
    const alts: AlternativeHypothesis[] = [
      {
        title: 'Bolsa de aire atrapada en un punto alto del ramal',
        likelihood: 'Media',
        supportingEvidence: 'Reduce la sección efectiva de paso y eleva la presión previa.',
        contradictingOrMissing: photoNote(ctx, 'Sin inspección visual analizada no se puede descartar ni confirmar.'),
      },
      {
        title: 'Cierre accidental de válvula por terceros',
        likelihood: 'Media',
        supportingEvidence: 'Produce exactamente caída de caudal con aumento de presión aguas arriba.',
        contradictingOrMissing: 'Requiere verificar físicamente la posición del volante y el número de vueltas.',
      },
    ];
    return {
      ...base,
      detectedProblem: `Estrangulamiento de flujo en ${node.name}: caída de caudal con acumulación de contrapresión.`,
      primaryHypothesis: 'Obstrucción parcial por incrustación, corrosión o desplazamiento de la compuerta en el elemento de regulación.',
      alternativeHypotheses: alts,
      uncertaintyStatement: 'El grado real de obstrucción interna solo puede verificarse al ejercitar o desmontar el elemento.',
      missingData: [`Registro de la última maniobra preventiva en ${node.assetCode}.`, 'Presión aguas abajo del elemento sospechoso.'],
      potentialImpact: `Baja presión para hasta ${hab(node.populationServed)} habitantes y riesgo de golpe de ariete si la compuerta colapsa.`,
      recommendedAction: `Inspeccionar ${node.name}, purgar aire, limpiar incrustaciones y programar la rehabilitación de la compuerta si se confirma.`,
      requiredResources: ['Llave de válvula y kit de limpieza mecánica', 'Válvula de repuesto del diámetro del nodo', 'Registrador portátil de presión diferencial'],
      interventionSteps: [
        'Medir presión con manómetro calibrado antes y después del elemento.',
        'Realizar una maniobra controlada de apertura y cierre verificando el tope mecánico.',
        'Purgar la cámara y limpiar depósitos en el vástago.',
        'Evaluar el reemplazo del cuerpo de válvula si la pérdida de carga persiste.',
      ],
    };
  }

  if (anomaly.category === 'sensor_fault') {
    return {
      ...base,
      detectedProblem: `Inconsistencia física o congelamiento de telemetría en ${node.name}.`,
      primaryHypothesis: 'Falla de calibración, deriva del lazo 4–20 mA, congelamiento del buffer de comunicación o humedad en el nodo sensor.',
      alternativeHypotheses: [
        {
          title: 'Pérdida de alimentación o falso contacto en el bus de comunicación',
          likelihood: 'Media',
          supportingEvidence: 'Genera lecturas fuera de rango o valores repetidos.',
          contradictingOrMissing: 'El nodo sigue transmitiendo paquetes periódicos.',
        },
        {
          title: 'Evento hidráulico real que el sensor refleja de forma extrema',
          likelihood: 'Baja',
          supportingEvidence: 'Una fuga o rotura real puede producir lecturas inusuales.',
          contradictingOrMissing: photoNote(ctx, 'Sin evidencia independiente analizada no se descarta del todo; vigilar nodos vecinos.'),
        },
      ],
      uncertaintyStatement: 'El estado real del parámetro afectado queda sin medición confiable hasta verificar en sitio; no se descarta un evento hidráulico concurrente.',
      missingData: ['Diagnóstico eléctrico de alimentación y señal del sensor.', 'Medición manual portátil en sitio.'],
      potentialImpact: `Pérdida de observabilidad en ${node.name} (${hab(node.populationServed)} usuarios); riesgo de falsas alarmas o de pasar por alto un evento real.`,
      recommendedAction: 'Despachar revisión de instrumentación y recalibración; mantener vigilancia en los nodos vecinos sin cerrar suministro.',
      requiredResources: ['Técnico de instrumentación', 'Multímetro y patrones de calibración', 'Módulo transductor de repuesto'],
      interventionSteps: [
        'Aislar las alertas automáticas de este sensor en la consola sin detener el bombeo.',
        'Medir parámetros manualmente en sitio con equipo portátil calibrado.',
        'Inspeccionar sellos, bornes y recalibrar la sonda.',
        'Validar 3 ciclos consecutivos consistentes antes de reincorporarlo.',
      ],
    };
  }

  if (anomaly.category === 'quality_drift') {
    return {
      ...base,
      detectedProblem: `Deriva moderada de calidad en ${node.name} (cloro ${node.current.chlorineMgL} mg/L, turbidez ${node.current.turbidityNtu} NTU, pH ${node.current.ph}).`,
      primaryHypothesis: 'Desajuste gradual de la dosificación de cloro residual o demanda estacional, sin arrastre de turbidez.',
      alternativeHypotheses: [
        {
          title: 'Consumo de cloro por tiempo de retención prolongado en el ramal',
          likelihood: 'Media',
          supportingEvidence: `La turbidez permanece baja (${node.current.turbidityNtu} NTU).`,
          contradictingOrMissing: 'Requiere medición de cloro libre con comparador DPD portátil en el punto de muestreo.',
        },
      ],
      uncertaintyStatement: 'No hay indicadores combinados de contaminación; se recomienda un ajuste operativo preventivo antes de escalar a alerta sanitaria.',
      missingData: ['Lectura DPD manual de cloro libre en la salida de planta y en el extremo del ramal.'],
      potentialImpact: `Posible pérdida de protección residual para ${hab(node.populationServed)} usuarios si el cloro sigue descendiendo.`,
      recommendedAction: 'Ajustar la dosificación de hipoclorito y verificar el cloro libre a los 30 minutos mediante muestreo DPD.',
      requiredResources: ['Operador de planta', 'Kit comparador DPD de cloro libre y pH'],
      interventionSteps: ['Verificar caudal y reserva del tanque dosificador.', 'Ajustar la bomba dosificadora y registrar la nueva lectura a los 30 minutos.'],
    };
  }

  // contamination (y cualquier otra categoría de calidad)
  return {
    ...base,
    detectedProblem: `Anomalía de calidad en ${node.name}: turbidez ${node.current.turbidityNtu} NTU y cloro libre ${node.current.chlorineMgL} mg/L.`,
    primaryHypothesis: 'Evento de arrastre de sedimentos o materia orgánica por escorrentía, o desajuste en la dosificación del desinfectante.',
    alternativeHypotheses: [
      {
        title: 'Alteración puntual aguas arriba de la captación',
        likelihood: 'Media',
        supportingEvidence: `Las lecturas (pH ${node.current.ph}, cloro ${node.current.chlorineMgL} mg/L) sugieren demanda externa.`,
        contradictingOrMissing: photoNote(ctx, 'No existe confirmación química ni microbiológica de laboratorio.'),
      },
      {
        title: 'Desajuste en la precloración o saturación de un filtro en planta',
        likelihood: 'Media',
        supportingEvidence: 'Explica el bajo cloro libre si la demanda aumentó.',
        contradictingOrMissing: 'Requiere inspección física del dosificador y muestreo comparativo.',
      },
    ],
    uncertaintyStatement:
      'Ni los sensores básicos ni una fotografía confirman el agente contaminante (biológico o químico). Es una alerta preventiva sujeta a muestreo de laboratorio.',
    missingData: ['Análisis microbiológico (coliformes, E. coli) y de metales o pesticidas.', 'Recorrido de inspección aguas arriba y verificación en planta.'],
    potentialImpact: `Exposición potencial de hasta ${hab(node.populationServed)} habitantes a agua fuera de norma si ingresa a distribución sin control.`,
    recommendedAction: 'Regular la admisión en la captación, operar con la reserva del tanque, tomar muestras estériles y verificar la cloración en planta.',
    requiredResources: ['Operador de planta y promotor sanitario comunitario', 'Frascos estériles, kit DPD y turbidímetro', 'Ajuste de coagulante y desinfectante en planta'],
    interventionSteps: [
      'Evaluar el cierre parcial de la compuerta para evitar el ingreso de sólidos a planta.',
      'Tomar 2 muestras estériles (captación y salida de planta) para análisis externo.',
      'Verificar la dosis de coagulante y el cloro residual en el tanque de reserva.',
      'Emitir un aviso preventivo a la comunidad si la reserva baja de un umbral operativo.',
    ],
  };
}

function leakBody(ctx: DiagnosisContext, base: Pick<DiagnosisBody, 'availableEvidences' | 'priority' | 'priorityScore' | 'evidenceLevel' | 'evidenceBasis'>): DiagnosisBody {
  const { anomaly, node, hydraulic } = ctx;
  const level = anomaly.hydraulicLevel ?? (hydraulic?.level === 'localized_leak' || hydraulic?.level === 'possible_leak' ? hydraulic.level : undefined);
  const reach = hydraulic?.reachLabels?.length ? hydraulic.reachLabels.join(', ') : hydraulic?.candidatePipeIds?.join(', ') ?? 'sin tramo identificado';
  const m3 = hydraulic?.estimatedLossM3PerDay;
  const loss = hydraulic?.excessLs !== undefined ? `${hydraulic.excessLs} ± ${hydraulic.sigmaLs ?? '?'} L/s` : null;

  if (level === 'localized_leak' || level === 'possible_leak') {
    const localized = level === 'localized_leak';
    return {
      ...base,
      detectedProblem: localized
        ? `Fuga localizada en el tramo ${reach}: exceso de caudal de ${loss} corroborado por la respuesta de presión.`
        : `Posible fuga asociada a ${node.name}: exceso de caudal de ${loss}; tramo(s) candidato(s): ${reach}.`,
      primaryHypothesis: localized
        ? `Pérdida de agua en el tramo ${reach} entre dos medidores (tubería, accesorios o cámara asociada).`
        : `Pérdida de agua aguas abajo de ${node.name}; los datos no permiten asegurar un único tramo.`,
      alternativeHypotheses: [
        {
          title: 'Deriva o error de calibración en los medidores de caudal',
          likelihood: 'Baja',
          supportingEvidence: 'Explicaría un exceso aparente de caudal.',
          contradictingOrMissing: 'La respuesta de presión es coherente con un caudal real adicional; haría falta que dos medidores derivaran a la vez.',
        },
        {
          title: 'Consumo no medido o toma no autorizada',
          likelihood: 'Media',
          supportingEvidence: 'Produce el mismo balance de caudal que una fuga.',
          contradictingOrMissing: photoNote(ctx, 'Sin inspección visual analizada no se puede distinguir una fuga de un consumo no medido.'),
        },
      ],
      uncertaintyStatement:
        'La resolución espacial es el tramo entre dos medidores; no se puede ubicar la fuga dentro del tramo. El caudal perdido es una estimación del desbalance respecto a la línea base, con una incertidumbre que supone medidores de ±2% sin calibración de campo.',
      missingData: [
        'Calibración reciente de los medidores de caudal de ambos extremos del tramo.',
        'Inspección acústica o prueba de presión del tramo.',
        'Presión en puntos intermedios del tramo.',
      ],
      potentialImpact: `Pérdida estimada${m3 !== undefined ? ` de ${m3} m³/día` : ''} si el caudal se mantiene constante (extrapolación del balance, sin validación de campo), con riesgo de baja presión para hasta ${hab(node.populationServed)} habitantes.`,
      recommendedAction: `Inspeccionar el tramo ${reach}: verificar los medidores de ambos extremos, realizar una prueba acústica y de presión, y aislar el tramo para confirmar.`,
      requiredResources: ['Cuadrilla hidráulica (2 técnicos)', 'Equipo de detección acústica y manómetro patrón portátil', 'Material de reparación del diámetro del tramo'],
      interventionSteps: [
        'Verificar la calibración de los medidores de entrada y salida del tramo.',
        'Realizar una prueba acústica de fugas a lo largo del tramo.',
        'Aislar el tramo con las válvulas de seccionamiento y confirmar la pérdida de presión.',
        'Excavar y reparar en el punto confirmado; presurizar gradualmente y verificar estabilidad por 15 minutos.',
      ],
    };
  }

  // Fuga detectada solo por la regla de caída de presión del nodo (sin corroboración por balance).
  return {
    ...base,
    detectedProblem: `Caída de presión en ${node.name} compatible con fuga, sin corroboración por balance de caudal.`,
    primaryHypothesis: 'Pérdida de carga atribuible a una fuga; también puede deberse a una maniobra operativa, a un cambio de nivel del tanque o a una falla del transmisor de presión.',
    alternativeHypotheses: [
      {
        title: 'Falla de calibración del transmisor de presión',
        likelihood: 'Media',
        supportingEvidence: 'Explicaría una caída de presión aislada.',
        contradictingOrMissing: 'Un balance de caudal consistente no confirma ni descarta una fuga pequeña.',
      },
      {
        title: 'Maniobra operativa o variación de nivel del tanque',
        likelihood: 'Media',
        supportingEvidence: 'Cambia la presión sin pérdida de agua.',
        contradictingOrMissing: photoNote(ctx, 'Requiere revisar el registro de maniobras y el nivel del tanque.'),
      },
    ],
    uncertaintyStatement: 'Con un solo canal (presión) no se puede distinguir una fuga de un cambio operativo o de una falla de instrumento.',
    missingData: ['Registro de maniobras de válvulas y bombeo.', 'Verificación manual de la presión con manómetro patrón.', 'Balance de caudal con ambos medidores sincronizados.'],
    potentialImpact: `Posible baja de servicio para hasta ${hab(node.populationServed)} habitantes si se confirma una pérdida.`,
    recommendedAction: `Verificar la presión en ${node.name} con manómetro patrón y revisar maniobras recientes antes de despachar una cuadrilla de reparación.`,
    requiredResources: ['Técnico de campo con manómetro patrón', 'Acceso al registro de maniobras'],
    interventionSteps: [
      'Revisar el registro de maniobras de válvulas y el nivel del tanque.',
      'Medir la presión con manómetro patrón y comparar con el transmisor.',
      'Si la caída se confirma, realizar prueba acústica aguas abajo del nodo.',
    ],
  };
}

export function evidenceLevelText(level: AquaBrainDiagnosis['evidenceLevel']): string {
  return level ? EVIDENCE_LEVEL_LABEL[level] : 'No evaluado';
}
