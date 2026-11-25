import { getLang } from './i18n';

/**
 * REQ-I18N-02: capa de presentación para el texto que genera el servidor o el motor.
 *
 * El motor hidráulico, las plantillas de diagnóstico, el ledger y el verificador emiten frases en español. Esas frases se
 * guardan, se sellan y se verifican tal cual: traducirlas en el motor cambiaría el hash del ledger y los resultados. Por eso
 * se traducen SOLO al mostrarlas, con plantillas que conservan cada cifra, identificador y nombre propio (nodos, tramos,
 * cuadrillas, notas escritas por personas). Lo que no reconoce una plantilla se muestra tal cual, nunca se inventa.
 *
 * Esta capa no importa nada del motor y no cambia ningún dato: `tr(x)` solo devuelve otra cadena para pintar.
 */

type Rule = { re: RegExp; en: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `{0}` captura un valor literal (cifra, id, nombre). `{~0}` captura una frase que también se traduce. */
function rule(es: string, en: string): Rule {
  const src = es
    .split(/(\{~?\d\})/)
    .map((part) => {
      const m = part.match(/^\{(~?)\d\}$/);
      return m ? (m[1] ? '(.+)' : '(.+?)') : escapeRe(part);
    })
    .join('');
  return { re: new RegExp(`^${src}$`, 's'), en };
}

const EXACT: Record<string, string> = {
  // Estados y niveles
  Abierta: 'Open',
  'En Progreso': 'In progress',
  Cerrada: 'Closed',
  Alta: 'High',
  Media: 'Medium',
  Baja: 'Low',
  Crítica: 'Critical',
  alta: 'high',
  media: 'medium',
  baja: 'low',
  'pendiente de verificación': 'pending verification',
  'mediciones simuladas recibidas': 'simulated measurements received',
  'recuperación verificada': 'recovery verified',
  'reparación reabierta': 'repair reopened',
  // Actores y proveedores
  'Sistema Aqua Sentinel': 'Aqua Sentinel system',
  'Motor Hidráulico': 'Hydraulic engine',
  'Motor Determinista (Ingesta)': 'Deterministic engine (ingest)',
  'Motor Determinista (Verificación)': 'Deterministic engine (verification)',
  'Motor Híbrido + Adaptador de Respaldo (Sin API Key)': 'Hybrid engine + fallback adapter (no API key)',
  'Adaptador de Respaldo Determinista (sin GEMINI_API_KEY)': 'Deterministic fallback adapter (no GEMINI_API_KEY)',
  'adaptador de respaldo': 'fallback adapter',
  'Visión no disponible (Sin API Key)': 'Vision unavailable (no API key)',
  'Ninguno: las fotografías quedan como "no analizadas"': 'None: photographs stay "not analyzed"',
  'Cargando proveedor...': 'Loading provider...',
  'SIMULADO · almacenamiento local del servidor (sin AWS S3)': 'SIMULATED · local server storage (no AWS S3)',
  'SIMULADO · rutas Express locales (sin AWS Lambda)': 'SIMULATED · local Express routes (no AWS Lambda)',
  'SIMULADO · archivo JSON local + IndexedDB offline (sin AWS DynamoDB)': 'SIMULATED · local JSON file + offline IndexedDB (no AWS DynamoDB)',
  'NO CONFIGURADO · se usa Gemini o el adaptador determinista': 'NOT CONFIGURED · Gemini or the deterministic adapter is used',
  'Modelo por defecto no validado con una clave real. Según la documentación de Google es un modelo heredado y sus peticiones se redirigen a modelos nuevos desde el 1 de diciembre de 2026: fija GEMINI_MODEL tras validarlo.':
    'Default model not validated with a real key. According to Google documentation it is a legacy model and its requests are redirected to newer models from 1 December 2026: set GEMINI_MODEL after validating it.',
  // Activos
  'Hormigón Armado + Rejilla Acero': 'Reinforced concrete + steel screen',
  'Acero Dúctil': 'Ductile steel',
  'Concreto Pretensado 450 m³': 'Prestressed concrete 450 m³',
  'PVC Presión PN10': 'PVC pressure PN10',
  'Hierro Fundido Bridado': 'Flanged cast iron',
  'Hierro Dúctil': 'Ductile iron',
  'Cuenca Alta': 'Upper basin',
  'Cota Superior': 'Upper level',
  'Sector Norte': 'North sector',
  'Sector Sur': 'South sector',
  'Centro Cívico': 'Civic centre',
  '1. Fuga en Troncal': '1. Trunk-main leak',
  '2. Obstrucción Válvula': '2. Valve obstruction',
  '3. Falla de Sensor': '3. Sensor fault',
  '4. Posible Contaminación': '4. Possible contamination',
  'Obstrucción progresiva en Válvula Sur': 'Progressive obstruction at the South valve',
  'Lectura físicamente inconsistente en Tanque Mirador': 'Physically inconsistent reading at the Mirador tank',
  'Anomalía de calidad en Bocatoma': 'Quality anomaly at the intake',
  'Inspección cámara Troncal Norte — Brida PVC fracturada': 'Camera inspection North trunk — Fractured PVC flange',
  'Reporte en Bocatoma Quebrada Alta — Agua marrón turbia': 'Report at Bocatoma Quebrada Alta — Cloudy brown water',
  'Cámara Válvula Sur — Corrosión e incrustaciones en compuerta': 'Cámara Válvula Sur — Corrosion and scale on the gate',
  'No se pudo contactar al servidor.': 'The server could not be reached.',  'solo ADMIN, con reautenticación, token de un solo uso, confirmación explícita y auditoría previa': 'ADMIN only, with re-authentication, a one-time token, explicit confirmation and prior auditing',
  'memoria de un solo proceso': 'single-process memory',
  'Entorno probablemente efímero: el estado se perderá al recrear el contenedor. Exporta un snapshot antes de la demo o monta un volumen y fija AQUA_STATE_PATH.': 'Probably an ephemeral environment: the state will be lost when the container is recreated. Export a snapshot before the demo, or mount a volume and set AQUA_STATE_PATH.',
  'Archivo local en el directorio de trabajo: sobrevive a reinicios del proceso, no a recrear el contenedor. Usa el snapshot exportable como respaldo.': 'Local file in the working directory: it survives process restarts, not container recreation. Use the exportable snapshot as a backup.',
  'AQUA_STATE_PATH configurado explícitamente; asegúrate de que apunte a un volumen persistente.': 'AQUA_STATE_PATH is set explicitly; make sure it points to a persistent volume.',
  'Registro deduplicado por clave idempotente; ya existía en servidor.': 'Record deduplicated by idempotency key; it already existed on the server.',  'Esta instancia contiene lecturas que no son sintéticas: no se inyectan mediciones simuladas.': 'This instance contains non-synthetic readings: simulated measurements are not injected.',
  'Solo se pueden simular mediciones de una orden cerrada que sigue pendiente de verificación.': 'Measurements can only be simulated for a closed order that is still pending verification.',
  // Motor hidráulico
  'Exceso de caudal frente al balance de masa, corroborado por la respuesta de presión': 'Flow excess against the mass balance, corroborated by the pressure response',
  '0.40 × Severidad Hidráulica + 0.30 × Población Expuesta + 0.20 × Riesgo Sanitario + 0.10 × Reglas Correlacionadas':
    '0.40 × Hydraulic severity + 0.30 × Exposed population + 0.20 × Health risk + 0.10 × Correlated rules',
  'Nodo con almacenamiento: el balance exige medir la salida y la variación de volumen, que no están disponibles.':
    'Storage node: the balance requires measuring the outflow and the volume change, which are not available.',
  'Falta algún nodo hijo en la topología.': 'A child node is missing from the topology.',
  'Las lecturas del nodo y sus hijos no están sincronizadas (más de 15 min de diferencia).': 'The readings of the node and its children are not synchronized (more than 15 min apart).',
  'No hay consumos finales medidos y sincronizados para estimar el factor de demanda.': 'There are no measured, synchronized end consumptions to estimate the demand factor.',
  'Deriva o error de calibración de un medidor de caudal.': 'Drift or calibration error of a flow meter.',
  'Demanda no uniforme: un consumo local mayor que el estimado con las hojas medidas.': 'Non-uniform demand: a local consumption higher than the one estimated from the measured leaves.',
  'Consumo no medido o toma no autorizada.': 'Unmetered consumption or unauthorized connection.',
  'Sin respuesta de presión coherente, el exceso se trata como anomalía de caudal y no como fuga.': 'Without a consistent pressure response, the excess is treated as a flow anomaly and not as a leak.',
  'La caída de presión es incoherente con el caudal estimado; no se concluye fuga hasta resolver la discrepancia.':
    'The pressure drop is inconsistent with the estimated flow; no leak is concluded until the discrepancy is resolved.',
  'La presión no puede corroborar este exceso; se necesita otra evidencia independiente (fotografía analizada, inspección, otro medidor).':
    'Pressure cannot corroborate this excess; other independent evidence is needed (an analyzed photograph, an inspection, another meter).',
  'Una fotografía vinculada a este incidente y analizada por un proveedor de visión es compatible con una fuga.':
    'A photograph linked to this incident and analyzed by a vision provider is compatible with a leak.',
  'La resolución espacial es el tramo entre dos medidores: no se puede ubicar una fuga dentro del tramo ni distinguirla de una fuga en el propio nodo.':
    'Spatial resolution is the pipe section between two meters: a leak cannot be located inside the section or told apart from a leak at the node itself.',
  'Los nodos con almacenamiento (tanques) no se evalúan: sin medir la salida ni el volumen no hay balance válido.':
    'Storage nodes (tanks) are not evaluated: without measuring the outflow or the volume there is no valid balance.',
  'Aguas arriba del tanque hay bombeo y no hay modelo de presión: allí una fuga no puede pasar de anomalía de caudal sin otra evidencia.':
    'Upstream of the tank there is pumping and no pressure model: there a leak cannot go beyond a flow anomaly without other evidence.',
  'El caudal perdido es una estimación del desbalance frente a un residuo de demanda estimado; la extrapolación a m³/día supone caudal constante.':
    'The lost flow is an estimate of the imbalance against an estimated demand residual; the extrapolation to m³/day assumes constant flow.',
  'Tramo aguas arriba del tanque (bombeo): no hay modelo de presión, así que la presión no puede corroborar ni descartar.':
    'Section upstream of the tank (pumping): there is no pressure model, so pressure can neither corroborate nor rule out.',
  'Faltan lecturas de presión válidas en el nodo o en el tanque.': 'Valid pressure readings are missing at the node or the tank.',
  // Diagnóstico: fuga
  'Deriva o error de calibración en los medidores de caudal': 'Drift or calibration error in the flow meters',
  'Explicaría un exceso aparente de caudal.': 'It would explain an apparent flow excess.',
  'La respuesta de presión es coherente con un caudal real adicional; haría falta que dos medidores derivaran a la vez.':
    'The pressure response is consistent with a real extra flow; two meters would have to drift at the same time.',
  'Consumo no medido o toma no autorizada': 'Unmetered consumption or unauthorized connection',
  'Produce el mismo balance de caudal que una fuga.': 'It produces the same flow balance as a leak.',
  'Sin inspección visual analizada no se puede distinguir una fuga de un consumo no medido.': 'Without an analyzed visual inspection a leak cannot be told apart from unmetered consumption.',
  'La resolución espacial es el tramo entre dos medidores; no se puede ubicar la fuga dentro del tramo. El caudal perdido es una estimación del desbalance respecto a la línea base, con una incertidumbre que supone medidores de ±2% sin calibración de campo.':
    'Spatial resolution is the pipe section between two meters; the leak cannot be located inside the section. The lost flow is an estimate of the imbalance against the baseline, with an uncertainty that assumes ±2% meters without field calibration.',
  'Calibración reciente de los medidores de caudal de ambos extremos del tramo.': 'Recent calibration of the flow meters at both ends of the section.',
  'Inspección acústica o prueba de presión del tramo.': 'Acoustic inspection or pressure test of the section.',
  'Presión en puntos intermedios del tramo.': 'Pressure at intermediate points of the section.',
  'Cuadrilla hidráulica (2 técnicos)': 'Hydraulic crew (2 technicians)',
  'Equipo de detección acústica y manómetro patrón portátil': 'Acoustic detection equipment and a portable reference pressure gauge',
  'Material de reparación del diámetro del tramo': 'Repair material for the section diameter',
  'Verificar la calibración de los medidores de entrada y salida del tramo.': 'Check the calibration of the inlet and outlet meters of the section.',
  'Realizar una prueba acústica de fugas a lo largo del tramo.': 'Run an acoustic leak test along the section.',
  'Aislar el tramo con las válvulas de seccionamiento y confirmar la pérdida de presión.': 'Isolate the section with the sectioning valves and confirm the pressure loss.',
  'Excavar y reparar en el punto confirmado; presurizar gradualmente y verificar estabilidad por 15 minutos.': 'Excavate and repair at the confirmed point; pressurize gradually and check stability for 15 minutes.',
  'Falla de calibración del transmisor de presión': 'Calibration fault of the pressure transmitter',
  'Explicaría una caída de presión aislada.': 'It would explain an isolated pressure drop.',
  'Un balance de caudal consistente no confirma ni descarta una fuga pequeña.': 'A consistent flow balance neither confirms nor rules out a small leak.',
  'Maniobra operativa o variación de nivel del tanque': 'Operating manoeuvre or tank level variation',
  'Pérdida de carga atribuible a una fuga; también puede deberse a una maniobra operativa, a un cambio de nivel del tanque o a una falla del transmisor de presión.':
    'Head loss attributable to a leak; it may also be due to an operating manoeuvre, a change in tank level or a pressure transmitter fault.',
  // Diagnóstico: obstrucción
  'Obstrucción parcial por incrustación, corrosión o desplazamiento de la compuerta en el elemento de regulación.': 'Partial obstruction from scaling, corrosion or displacement of the gate in the regulating element.',
  'Bolsa de aire atrapada en un punto alto del ramal': 'Air pocket trapped at a high point of the branch',
  'Reduce la sección efectiva de paso y eleva la presión previa.': 'It reduces the effective flow section and raises the upstream pressure.',
  'Sin inspección visual analizada no se puede descartar ni confirmar.': 'Without an analyzed visual inspection it can be neither ruled out nor confirmed.',
  'Cierre accidental de válvula por terceros': 'Accidental valve closure by third parties',
  'Produce exactamente caída de caudal con aumento de presión aguas arriba.': 'It produces exactly a flow drop with an upstream pressure rise.',
  'Requiere verificar físicamente la posición del volante y el número de vueltas.': 'It requires physically checking the handwheel position and the number of turns.',
  'El grado real de obstrucción interna solo puede verificarse al ejercitar o desmontar el elemento.': 'The real degree of internal obstruction can only be checked by exercising or dismantling the element.',
  'Presión aguas abajo del elemento sospechoso.': 'Pressure downstream of the suspect element.',
  'Llave de válvula y kit de limpieza mecánica': 'Valve wrench and mechanical cleaning kit',
  'Válvula de repuesto del diámetro del nodo': 'Spare valve of the node diameter',
  'Registrador portátil de presión diferencial': 'Portable differential pressure logger',
  'Medir presión con manómetro calibrado antes y después del elemento.': 'Measure pressure with a calibrated gauge before and after the element.',
  'Realizar una maniobra controlada de apertura y cierre verificando el tope mecánico.': 'Perform a controlled open-and-close manoeuvre checking the mechanical stop.',
  'Purgar la cámara y limpiar depósitos en el vástago.': 'Purge the chamber and clean deposits on the stem.',
  'Evaluar el reemplazo del cuerpo de válvula si la pérdida de carga persiste.': 'Evaluate replacing the valve body if the head loss persists.',
  'Reducción severa de caudal con sobrepresión previa (obstrucción)': 'Severe flow reduction with upstream overpressure (obstruction)',
  // Diagnóstico: falla de sensor
  'Inconsistencia física de telemetría (probable falla de sensor)': 'Physical inconsistency in telemetry (probable sensor fault)',
  'Sensor congelado sin varianza física (stuck-at-value)': 'Frozen sensor with no physical variance (stuck-at-value)',
  'Falla de calibración, deriva del lazo 4–20 mA, congelamiento del buffer de comunicación o humedad en el nodo sensor.': 'Calibration fault, 4–20 mA loop drift, frozen communication buffer or moisture in the sensor node.',
  'Pérdida de alimentación o falso contacto en el bus de comunicación': 'Loss of power or a bad contact on the communication bus',
  'Genera lecturas fuera de rango o valores repetidos.': 'It produces out-of-range readings or repeated values.',
  'El nodo sigue transmitiendo paquetes periódicos.': 'The node keeps transmitting periodic packets.',
  'Evento hidráulico real que el sensor refleja de forma extrema': 'A real hydraulic event that the sensor reflects in an extreme way',
  'Una fuga o rotura real puede producir lecturas inusuales.': 'A real leak or burst can produce unusual readings.',
  'Sin evidencia independiente analizada no se descarta del todo; vigilar nodos vecinos.': 'Without independent analyzed evidence it cannot be fully ruled out; watch neighbouring nodes.',
  'El estado real del parámetro afectado queda sin medición confiable hasta verificar en sitio; no se descarta un evento hidráulico concurrente.':
    'The real state of the affected parameter has no reliable measurement until checked on site; a concurrent hydraulic event is not ruled out.',
  'Diagnóstico eléctrico de alimentación y señal del sensor.': 'Electrical diagnosis of the sensor power and signal.',
  'Medición manual portátil en sitio.': 'Portable manual measurement on site.',
  'Técnico de instrumentación': 'Instrumentation technician',
  'Multímetro y patrones de calibración': 'Multimeter and calibration standards',
  'Módulo transductor de repuesto': 'Spare transducer module',
  'Aislar las alertas automáticas de este sensor en la consola sin detener el bombeo.': 'Isolate the automatic alerts of this sensor in the console without stopping the pumping.',
  'Medir parámetros manualmente en sitio con equipo portátil calibrado.': 'Measure parameters manually on site with calibrated portable equipment.',
  'Inspeccionar sellos, bornes y recalibrar la sonda.': 'Inspect seals and terminals and recalibrate the probe.',
  'Validar 3 ciclos consecutivos consistentes antes de reincorporarlo.': 'Validate 3 consecutive consistent cycles before putting it back in service.',
  // Diagnóstico: calidad
  'Desviación múltiple o severa de parámetros de calidad (riesgo sanitario)': 'Multiple or severe deviation of quality parameters (health risk)',
  'Deriva operativa de desinfectante / pH (sin turbidez asociada)': 'Operational drift of disinfectant / pH (no associated turbidity)',
  'Evento de arrastre de sedimentos o materia orgánica por escorrentía, o desajuste en la dosificación del desinfectante.':
    'Sediment or organic-matter wash-in from runoff, or a disinfectant dosing mismatch.',
  'Desajuste gradual de la dosificación de cloro residual o demanda estacional, sin arrastre de turbidez.': 'Gradual mismatch in residual chlorine dosing or seasonal demand, with no turbidity wash-in.',
  'Consumo de cloro por tiempo de retención prolongado en el ramal': 'Chlorine consumption from a long retention time in the branch',
  'Alteración puntual aguas arriba de la captación': 'Localized disturbance upstream of the intake',
  'No existe confirmación química ni microbiológica de laboratorio.': 'There is no chemical or microbiological laboratory confirmation.',
  'Desajuste en la precloración o saturación de un filtro en planta': 'Pre-chlorination mismatch or saturation of a filter in the plant',
  'Explica el bajo cloro libre si la demanda aumentó.': 'It explains the low free chlorine if demand increased.',
  'Requiere inspección física del dosificador y muestreo comparativo.': 'It requires a physical inspection of the doser and comparative sampling.',
  'Ni los sensores básicos ni una fotografía confirman el agente contaminante (biológico o químico). Es una alerta preventiva sujeta a muestreo de laboratorio.':
    'Neither basic sensors nor a photograph confirm the contaminating agent (biological or chemical). This is a preventive alert subject to laboratory sampling.',
  'Análisis microbiológico (coliformes, E. coli) y de metales o pesticidas.': 'Microbiological analysis (coliforms, E. coli) and metals or pesticides.',
  'Recorrido de inspección aguas arriba y verificación en planta.': 'Upstream inspection walk and verification at the plant.',
  'Operador de planta y promotor sanitario comunitario': 'Plant operator and community health promoter',
  'Frascos estériles, kit DPD y turbidímetro': 'Sterile bottles, DPD kit and turbidimeter',
  'Ajuste de coagulante y desinfectante en planta': 'Coagulant and disinfectant adjustment at the plant',
  'Evaluar el cierre parcial de la compuerta para evitar el ingreso de sólidos a planta.': 'Evaluate partially closing the gate to keep solids out of the plant.',
  'Tomar 2 muestras estériles (captación y salida de planta) para análisis externo.': 'Take 2 sterile samples (intake and plant outlet) for external analysis.',
  'Verificar la dosis de coagulante y el cloro residual en el tanque de reserva.': 'Check the coagulant dose and the residual chlorine in the reserve tank.',
  'Emitir un aviso preventivo a la comunidad si la reserva baja de un umbral operativo.': 'Issue a preventive notice to the community if the reserve falls below an operating threshold.',
  // Visión
  'No hay proveedor de visión configurado (falta GEMINI_API_KEY).': 'No vision provider is configured (GEMINI_API_KEY is missing).',
  'El contenido de la imagen no fue analizado por ningún proveedor de visión: no se afirma nada sobre lo que muestra.': 'The image content was not analyzed by any vision provider: nothing is claimed about what it shows.',
  'Análisis visual con un proveedor de visión operativo o inspección humana de la fotografía.': 'Visual analysis with a working vision provider, or human inspection of the photograph.',
  'No analizada: la fotografía queda registrada como adjunto y no se usa como evidencia automática.': 'Not analyzed: the photograph is stored as an attachment and is not used as automatic evidence.',
  'Fotografía vinculada al incidente pero NO analizada por ningún proveedor de visión: no se usa como evidencia.': 'Photograph linked to the incident but NOT analyzed by any vision provider: it is not used as evidence.',
  'Hay una fotografía vinculada pero ningún proveedor de visión la analizó: no se usa como evidencia.': 'A photograph is linked but no vision provider analyzed it: it is not used as evidence.',
  'No hay fotografía vinculada a este incidente.': 'No photograph is linked to this incident.',
  'La imagen fue analizada y no discrimina una categoría.': 'The image was analyzed and does not discriminate a category.',
  // Concordancia
  'Un canal analizado contradice la hipótesis: resolver la contradicción en campo antes de actuar.': 'An analyzed channel contradicts the hypothesis: resolve the contradiction in the field before acting.',
  'Un canal adicional coincide con los sensores; falta corroboración del otro.': 'One additional channel agrees with the sensors; the other lacks corroboration.',
  'Solo el detector sobre los sensores respalda la hipótesis.': 'Only the detector on the sensors supports the hypothesis.',
  'Solo un reporte declarado por una persona respalda la hipótesis; ningún sensor ni otro canal lo confirma.': 'Only a report declared by a person supports the hypothesis; no sensor or other channel confirms it.',
  'El balance hidráulico no aplica a esta categoría.': 'The hydraulic balance does not apply to this category.',
  'No se calculó el balance hidráulico.': 'The hydraulic balance was not computed.',
  'Hay una anomalía de caudal, pero la presión no la corrobora o no es evaluable: puede ser deriva de medidor o demanda no uniforme.':
    'There is a flow anomaly, but pressure does not corroborate it or cannot be evaluated: it may be meter drift or non-uniform demand.',
  'Datos insuficientes para evaluar el balance; no corrobora ni descarta.': 'Insufficient data to evaluate the balance; it neither corroborates nor rules out.',
  'El balance no muestra un exceso de caudal significativo; una fuga pequeña puede estar por debajo del límite de detección.':
    'The balance shows no significant flow excess; a small leak may be below the detection limit.',
  // Verificador de expedientes
  'Formato del expediente': 'Dossier format',
  'Cadena SHA-256 del Trust Ledger': 'SHA-256 chain of the Trust Ledger',
  'El cierre de la orden está registrado en el ledger': 'The order closing is recorded in the ledger',
  'El digest del expediente completo coincide con el sellado en el ledger': 'The digest of the full dossier matches the one sealed in the ledger',
  'Cada componente coincide con su digest sellado': 'Every component matches its sealed digest',
  'La orden es coherente con la historia del ledger (responsable, checklist, foto)': 'The order agrees with the ledger history (assignee, checklist, photo)',
  'La foto de cierre coincide byte a byte con el hash sellado': 'The closing photo matches the sealed hash byte for byte',
  'Verificación posterior a la reparación': 'Post-repair verification',
  'El veredicto de la reparación se recomputa con las mediciones selladas': 'The repair verdict is recomputed from the sealed measurements',
  'Los metadatos (datos sintéticos) coinciden con el contenido sellado': 'The metadata (synthetic data) matches the sealed content',
  'La clave del emisor coincide con la del recibo': 'The issuer key matches the receipt key',
  'La clave del emisor es la fijada por el verificador': 'The issuer key is the one pinned by the verifier',
  'Firma Ed25519 del recibo': 'Ed25519 signature of the receipt',
  'El recibo firmado corresponde a este contenido y a este bloque del ledger': 'The signed receipt matches this content and this ledger block',
  'El ancla fue firmada por la misma clave': 'The anchor was signed by the same key',
  'Firma Ed25519 del ancla': 'Ed25519 signature of the anchor',
  'El ledger contiene la cabeza certificada por el ancla (sin truncamiento)': 'The ledger contains the head certified by the anchor (no truncation)',
  'El ancla es posterior al cierre': 'The anchor comes after the closing',
  'Coincide con la clave fijada.': 'Matches the pinned key.',
  'Firma sobre {orden, digest, bloque de cierre}.': 'Signature over {order, digest, closing block}.',
  'Orden, digest, índice y hash del bloque de cierre deben coincidir con lo firmado.': 'Order, digest, index and closing block hash must match what was signed.',
  'keyId del ancla.': 'Anchor keyId.',
  'Firma sobre {altura, hash de cabeza}.': 'Signature over {height, head hash}.',
  'Coherente.': 'Consistent.',
  Coinciden: 'Match',
  'Coinciden.': 'Match.',
  'Recibo y ancla firmados por la clave fijada, y el ledger contiene la cabeza certificada.': 'Receipt and anchor signed by the pinned key, and the ledger contains the certified head.',
  'Ni el ledger ni las firmas hacen el sistema inmutable: quien controle el servidor puede reescribir su historia y firmar de nuevo. La protección real viene de conservar fuera del servidor los recibos, las anclas y la huella de la clave pública.':
    'Neither the ledger nor the signatures make the system immutable: whoever controls the server can rewrite its history and sign again. Real protection comes from keeping the receipts, the anchors and the public key fingerprint outside the server.',
  'Pendiente: el expediente todavía no afirma que la reparación funcionó (no hay mediciones posteriores suficientes).':
    'Pending: the dossier does not yet claim the repair worked (there are not enough later measurements).',
  'El indicador syntheticData no corresponde al contenido sellado.': 'The syntheticData flag does not match the sealed content.',
  'El bloque de cierre no coincide con el índice o hash declarados en el sello.': 'The closing block does not match the index or hash declared in the seal.',
  'El cierre no selló un digest de expediente.': 'The closing did not seal a dossier digest.',
  'El contenido del expediente fue modificado respecto a lo sellado al cierre.': 'The dossier content was modified after what was sealed at closing.',
  'El expediente no incluye la foto; solo se puede comprobar su hash.': 'The dossier does not include the photo; only its hash can be checked.',
  'Formato no reconocido o incompleto (se espera aqua-sentinel-dossier/2 con sealed, seal y ledger).': 'Unrecognized or incomplete format (aqua-sentinel-dossier/2 with sealed, seal and ledger is expected).',
  // Reparación
  'Aún no hay mediciones posteriores al cierre de la orden.': 'There are no measurements after the order was closed yet.',
  'Las mediciones posteriores indican un sensor defectuoso o imposible: no sirven como evidencia.': 'The later measurements indicate a faulty or impossible sensor: they are not usable as evidence.',
  'Las mediciones del punto son normales, pero el balance hidráulico aún muestra un exceso de caudal sin concluir fuga: no se puede confirmar.':
    'The point measurements are normal, but the hydraulic balance still shows a flow excess without concluding a leak: it cannot be confirmed.',
  // Errores del servidor
  'Ruta de API no encontrada.': 'API route not found.',
  'Orden de trabajo no encontrada.': 'Work order not found.',
  'Diagnóstico no encontrado.': 'Diagnosis not found.',
  'Autenticación requerida.': 'Authentication required.',
  'Token CSRF ausente o inválido.': 'CSRF token missing or invalid.',
  'Token CSRF ausente o inválido. Recarga la página.': 'CSRF token missing or invalid. Reload the page.',
  'Credenciales inválidas.': 'Invalid credentials.',
  'No encontrado.': 'Not found.',
  'La contraseña actual no es correcta.': 'The current password is not correct.',
  'La contraseña no es correcta.': 'The password is not correct.',
  'Tu rol no puede realizar esta operación.': 'Your role cannot perform this operation.',
  'Tu rol no tiene permiso para esta operación.': 'Your role does not have permission for this operation.',
  'Origen no permitido.': 'Origin not allowed.',
  'Error interno del servidor. El servidor sigue en funcionamiento.': 'Internal server error. The server is still running.',
  'Demasiadas conexiones de eventos abiertas.': 'Too many open event connections.',
  'Snapshot rechazado.': 'Snapshot rejected.',
  'Falta evidencia fotográfica de cierre.': 'Closing photo evidence is missing.',
  'Reporte incompleto (idempotencyKey, nodeId y description son obligatorios).': 'Incomplete report (idempotencyKey, nodeId and description are required).',
  'La fotografía adjunta no es una imagen JPEG, PNG o WebP válida.': 'The attached photograph is not a valid JPEG, PNG or WebP image.',
  'Estado inválido: solo "En Progreso" o "Cerrada".': 'Invalid status: only "In progress" or "Closed".',
  'La orden está cerrada; el checklist ya no es editable.': 'The order is closed; the checklist can no longer be edited.',
  'La orden está cerrada; no se puede reemplazar la evidencia.': 'The order is closed; the evidence cannot be replaced.',
  'Ítem de checklist no encontrado.': 'Checklist item not found.',
  'El responsable debe ser texto.': 'The assignee must be text.',
  'El responsable debe tener al menos 2 caracteres.': 'The assignee must have at least 2 characters.',
  'La evidencia debe ser un data URL de imagen.': 'The evidence must be an image data URL.',
  'Formato de evidencia inválido (se requiere imagen base64).': 'Invalid evidence format (a base64 image is required).',
  'Tipo de imagen no permitido (usa JPEG, PNG o WebP).': 'Image type not allowed (use JPEG, PNG or WebP).',
  'La imagen está vacía.': 'The image is empty.',
  'El expediente guardado en el servidor no supera su propia verificación: posible alteración del estado.': 'The dossier stored on the server fails its own verification: the state may have been altered.',
};

const RULES: Rule[] = [
  // Anomalías y diagnóstico hidráulico
  rule('Fuga localizada en el tramo {0}: exceso de caudal de {1} ± {2} L/s', 'Localized leak on section {0}: flow excess of {1} ± {2} L/s'),
  rule('Posible fuga desde {0}: exceso de caudal de {1} ± {2} L/s (tramos candidatos: {3})', 'Possible leak from {0}: flow excess of {1} ± {2} L/s (candidate sections: {3})'),
  rule('Fuga localizada en el tramo {0}: exceso de caudal de {1} corroborado por la respuesta de presión.', 'Localized leak on section {0}: flow excess of {1} corroborated by the pressure response.'),
  rule('Posible fuga asociada a {0}: exceso de caudal de {1}; tramo(s) candidato(s): {2}.', 'Possible leak associated with {0}: flow excess of {1}; candidate section(s): {2}.'),
  rule('Pérdida de agua en el tramo {0} entre dos medidores (tubería, accesorios o cámara asociada).', 'Water loss on section {0} between two meters (pipe, fittings or associated chamber).'),
  rule('Pérdida de agua aguas abajo de {0}; los datos no permiten asegurar un único tramo.', 'Water loss downstream of {0}; the data cannot confirm a single section.'),
  rule('Entran {0} L/s y salen {1} L/s hacia {2}; con el factor de demanda {3} se esperaba un residuo de {4} L/s (línea base {5} L/s).', '{0} L/s enter and {1} L/s leave towards {2}; with demand factor {3} a residual of {4} L/s was expected (baseline {5} L/s).'),
  rule('Exceso de {0} L/s con incertidumbre ±{1} L/s (z = {2}); límite de detección en este nodo: {3} L/s.', 'Excess of {0} L/s with uncertainty ±{1} L/s (z = {2}); detection limit at this node: {3} L/s.'),
  rule('La presión bajó {0} bar frente a {1} bar predichos para ese exceso de caudal (razón {2}): coherente.', 'Pressure dropped {0} bar against {1} bar predicted for that flow excess (ratio {2}): consistent.'),
  rule('La presión bajó {0} bar, mucho más de lo que explica ese exceso de caudal ({1} bar): puede haber una rotura mayor, una válvula parcialmente cerrada o una falla del transmisor.',
    'Pressure dropped {0} bar, far more than that flow excess explains ({1} bar): there may be a larger burst, a partially closed valve or a transmitter fault.'),
  rule('Se esperaba una caída de unos {0} bar y se observó {1} bar: el exceso de caudal NO viene acompañado de la respuesta de presión de un caudal real adicional (sugiere deriva de medidor).',
    'A drop of about {0} bar was expected and {1} bar was observed: the flow excess is NOT accompanied by the pressure response of a real extra flow (it suggests meter drift).'),
  rule('Un exceso de {0} L/s solo bajaría la presión unos {1} bar, por debajo de {2} bar ({3}σ de los transmisores): la presión no puede discriminar.',
    'An excess of {0} L/s would only lower the pressure by about {1} bar, below {2} bar ({3}σ of the transmitters): pressure cannot discriminate.'),
  rule('Un único tramo candidato entre dos medidores ({0}). No se puede ubicar la fuga dentro del tramo ni distinguirla de una fuga en el propio nodo {1}.',
    'A single candidate section between two meters ({0}). The leak cannot be located inside the section or told apart from a leak at the node {1} itself.'),
  rule('Un único tramo candidato entre dos medidores ({0}).', 'A single candidate section between two meters ({0}).'),
  rule('No se puede ubicar la fuga dentro del tramo ni distinguirla de una fuga en el propio nodo {0}.', 'The leak cannot be located inside the section or told apart from a leak at the node {0} itself.'),
  rule('Hay {0} tramos candidatos desde {1}: los medidores disponibles no los distinguen.', 'There are {0} candidate sections from {1}: the available meters cannot tell them apart.'),
  rule('Pendiente de persistencia: {0} de {1} evaluaciones consecutivas con exceso.', 'Pending persistence: {0} of {1} consecutive evaluations with excess.'),
  rule('{0}: no evaluable. {~1}', '{0}: not evaluable. {1}'),
  rule('El medidor de {0} está marcado con falla de sensor.', 'The meter of {0} is flagged with a sensor fault.'),
  rule('{0}: lectura de caudal o fecha no válida.', '{0}: invalid flow reading or date.'),
  rule('{0}: las salidas medidas superan a la entrada en {1} L/s respecto a lo esperado (±{2}). Una fuga no explica eso: revisar calibración de medidores o una demanda que cayó.',
    '{0}: the measured outflows exceed the inflow by {1} L/s against what was expected (±{2}). A leak does not explain that: check meter calibration or a demand that fell.'),
  rule('La incertidumbre de los medidores (±{0}%) y de los transmisores de presión (±{1} bar) son supuestos sin calibración de campo.', 'The uncertainty of the meters (±{0}%) and of the pressure transmitters (±{1} bar) are assumptions without field calibration.'),
  rule('Balance hidráulico: exceso de caudal de {0} L/s (±{1}) con respuesta de presión coherente (fuga localizada).', 'Hydraulic balance: flow excess of {0} L/s (±{1}) with a consistent pressure response (localized leak).'),
  rule('Balance hidráulico: exceso de caudal de {0} L/s (±{1}) con respuesta de presión coherente (posible fuga).', 'Hydraulic balance: flow excess of {0} L/s (±{1}) with a consistent pressure response (possible leak).'),
  rule('Topología: {0} abastece a {1} habitantes en {2}.', 'Topology: {0} supplies {1} inhabitants in {2}.'),
  rule('Propagación en el grafo: {0} nodo(s) aguas abajo expuestos ({1}); población potencialmente impactada: {2} hab.', 'Graph propagation: {0} downstream node(s) exposed ({1}); potentially affected population: {2} inhab.'),
  rule('Pérdida estimada de {0} m³/día si el caudal se mantiene constante (extrapolación del balance, sin validación de campo), con riesgo de baja presión para hasta {1} habitantes.',
    'Estimated loss of {0} m³/day if the flow stays constant (balance extrapolation, no field validation), with a risk of low pressure for up to {1} inhabitants.'),
  rule('Pérdida estimada si el caudal se mantiene constante (extrapolación del balance, sin validación de campo), con riesgo de baja presión para hasta {0} habitantes.',
    'Estimated loss if the flow stays constant (balance extrapolation, no field validation), with a risk of low pressure for up to {0} inhabitants.'),
  rule('Inspeccionar el tramo {0}: verificar los medidores de ambos extremos, realizar una prueba acústica y de presión, y aislar el tramo para confirmar.',
    'Inspect section {0}: check the meters at both ends, run an acoustic and pressure test, and isolate the section to confirm.'),
  rule('Caída de presión en {0} compatible con fuga, sin corroboración por balance de caudal.', 'Pressure drop at {0} consistent with a leak, without corroboration from the flow balance.'),
  // Otros diagnósticos
  rule('Estrangulamiento de flujo en {0}: caída de caudal con acumulación de contrapresión.', 'Flow throttling at {0}: flow drop with back-pressure build-up.'),
  rule('Inconsistencia física o congelamiento de telemetría en {0}.', 'Physical inconsistency or frozen telemetry at {0}.'),
  rule('Anomalía de calidad en {0}: turbidez {1} NTU y cloro libre {2} mg/L.', 'Quality anomaly at {0}: turbidity {1} NTU and free chlorine {2} mg/L.'),
  rule('Deriva moderada de calidad en {0} (cloro {1} mg/L, turbidez {2} NTU, pH {3}).', 'Moderate quality drift at {0} (chlorine {1} mg/L, turbidity {2} NTU, pH {3}).'),
  rule('Baja presión para hasta {0} habitantes y riesgo de golpe de ariete si la compuerta colapsa.', 'Low pressure for up to {0} inhabitants and a water-hammer risk if the gate collapses.'),
  rule('Pérdida de observabilidad en {0} ({1} usuarios); riesgo de falsas alarmas o de pasar por alto un evento real.', 'Loss of observability at {0} ({1} users); risk of false alarms or of missing a real event.'),
  rule('Exposición potencial de hasta {0} habitantes a agua fuera de norma si ingresa a distribución sin control.', 'Potential exposure of up to {0} inhabitants to out-of-standard water if it enters distribution uncontrolled.'),
  rule('Inspeccionar {0}, purgar aire, limpiar incrustaciones y programar la rehabilitación de la compuerta si se confirma.', 'Inspect {0}, purge air, clean scale and schedule the gate rehabilitation if confirmed.'),
  rule('Despachar revisión de instrumentación y recalibración; mantener vigilancia en los nodos vecinos sin cerrar suministro.', 'Dispatch an instrumentation check and recalibration; keep watching the neighbouring nodes without cutting supply.'),
  rule('Regular la admisión en la captación, operar con la reserva del tanque, tomar muestras estériles y verificar la cloración en planta.', 'Regulate the intake, operate from the tank reserve, take sterile samples and check chlorination at the plant.'),
  rule('Registro de la última maniobra preventiva en {0}.', 'Record of the last preventive manoeuvre on {0}.'),
  rule('Las lecturas (pH {0}, cloro {1} mg/L) sugieren demanda externa.', 'The readings (pH {0}, chlorine {1} mg/L) suggest external demand.'),
  rule('Caudal descendió {0}% ({1} L/s vs {2} L/s base) mientras la presión subió +{3}% ({4} bar), indicando estrangulamiento u obstrucción en válvula/tramo.',
    'Flow fell {0}% ({1} L/s vs {2} L/s baseline) while pressure rose +{3}% ({4} bar), indicating throttling or an obstruction in the valve/section.'),
  rule('Balance nodal en {0}: entrada {1} L/s vs salida aguas abajo {2} L/s (desviación {3} L/s, {4}%).', 'Node balance at {0}: inflow {1} L/s vs downstream outflow {2} L/s (deviation {3} L/s, {4}%).'),
  rule('Desbalance de masa en grafo hidráulico ({0})', 'Mass imbalance in the hydraulic graph ({0})'),
  rule('Valor físico imposible detectado ({0} = {1}). Un transductor calibrado no puede emitir magnitudes negativas.', 'Physically impossible value detected ({0} = {1}). A calibrated transducer cannot output negative magnitudes.'),
  rule('Caudal nulo ({0} L/s) coexistiendo con presión elevada ({1} bar) con válvula abierta.', 'Zero flow ({0} L/s) coexisting with high pressure ({1} bar) with the valve open.'),
  rule('Presión cayó {0}% ({1} bar vs {2} bar base)', 'Pressure fell {0}% ({1} bar vs {2} bar baseline)'),
  rule('Parámetros fuera de rango operativo seguro: turbidez {0} NTU (>4.0 NTU), cloro residual {1} mg/L (<0.30 mg/L), pH {2} (fuera de 6.5–8.5). Requiere muestreo confirmatorio.',
    'Parameters outside the safe operating range: turbidity {0} NTU (>4.0 NTU), residual chlorine {1} mg/L (<0.30 mg/L), pH {2} (outside 6.5–8.5). Confirmatory sampling is required.'),
  rule('Parámetros fuera de rango operativo seguro: turbidez {0} NTU (>4.0 NTU). Requiere muestreo confirmatorio.', 'Parameters outside the safe operating range: turbidity {0} NTU (>4.0 NTU). Confirmatory sampling is required.'),
  rule('Parámetros fuera de rango operativo seguro: cloro residual {0} mg/L (<0.30 mg/L). Requiere muestreo confirmatorio.', 'Parameters outside the safe operating range: residual chlorine {0} mg/L (<0.30 mg/L). Confirmatory sampling is required.'),
  rule('Reducción severa de caudal acompañada de sobrepresión previa en {0} (lectura sintética de demostración).', 'Severe flow reduction with upstream overpressure at {0} (synthetic demonstration reading).'),
  rule('Turbidez y cloro libre fuera de rango en {0} (lectura sintética de demostración). Una fotografía solo cuenta si un proveedor de visión la analiza.',
    'Turbidity and free chlorine out of range at {0} (synthetic demonstration reading). A photograph only counts if a vision provider analyzes it.'),
  rule('El nodo reporta turbidez negativa y caudal cero mientras mantiene presión alta sin cierre de válvula (lectura sintética de demostración).',
    'The node reports negative turbidity and zero flow while keeping high pressure with no valve closure (synthetic demonstration reading).'),
  rule('Inspección cámara {0} (fotografía de demostración)', 'Camera inspection {0} (demonstration photograph)'),
  rule('{0} (fotografía de demostración)', '{0} (demonstration photograph)'),
  rule('Reporte en {0} (fotografía de demostración)', 'Report at {0} (demonstration photograph)'),
  rule('{0} regla(s) determinista(s) respaldan "{1}".', '{0} deterministic rule(s) support "{1}".'),
  rule('Exceso de caudal de {0} L/s (±{1}) corroborado por la respuesta de presión (localizada). Tramo(s) candidato(s): {2}.', 'Flow excess of {0} L/s (±{1}) corroborated by the pressure response (localized). Candidate section(s): {2}.'),
  rule('Exceso de caudal de {0} L/s (±{1}) corroborado por la respuesta de presión (posible fuga). Tramo(s) candidato(s): {2}.', 'Flow excess of {0} L/s (±{1}) corroborated by the pressure response (possible leak). Candidate section(s): {2}.'),
  rule('Una persona reportó "{0}" en campo. Es un dato declarado: ningún sensor lo confirma.', 'A person reported "{0}" in the field. It is declared data: no sensor confirms it.'),
  rule('La imagen analizada es compatible con "{0}".', 'The analyzed image is consistent with "{0}".'),
  rule('El balance hidráulico y la fotografía analizada coinciden con {~0}.', 'The hydraulic balance and the analyzed photograph agree with {0}.'),
  rule('Un canal adicional coincide con {~0}; falta corroboración del otro.', 'One additional channel agrees with {0}; the other lacks corroboration.'),
  rule('el reporte declarado', 'the declared report'),
  rule('los sensores', 'the sensors'),
  // Ledger
  rule('Inicialización de red comunitaria sintética ({0} nodos hidráulicos) con línea base nominal.', 'Initialization of the synthetic community network ({0} hydraulic nodes) with a nominal baseline.'),
  rule('Hipótesis: {~0} (Respaldo de evidencia: {~1})', 'Hypothesis: {0} (Evidence support: {1})'),
  rule('{0} emitida [{~1}]: {~2}', '{0} issued [{1}]: {2}'),
  rule('{0} cambió a {~1}', '{0} changed to {1}'),
  rule('{0} · {1}: {~2}', '{0} · {1}: {2}'),
  rule('{0}: foto de cierre {1} ({2}) sha256:{3}… (solo se sella el hash: el contenido de la foto no se analiza)', '{0}: closing photo {1} ({2}) sha256:{3}… (only the hash is sealed: the photo content is not analyzed)'),
  rule('{0} cerrada con checklist completo y foto sha256:{1}…; expediente sellado sha256:{2}…: {3}', '{0} closed with a complete checklist and photo sha256:{1}…; dossier sealed sha256:{2}…: {3}'),
  rule('{0}: se simularon {1} medición(es) posterior(es) al cierre (modo «{2}»). Son datos SINTÉTICOS generados por el solver hidráulico.', '{0}: {1} measurement(s) after closing were simulated (mode "{2}"). They are SYNTHETIC data generated by the hydraulic solver.'),
  rule('{0}: reparación verificada. {~1}', '{0}: repair verified. {1}'),
  rule('{0}: reparación reabierta. {~1}', '{0}: repair reopened. {1}'),
  rule('{0} mediciones consecutivas posteriores al cierre dentro de lo normal (datos simulados), y el balance hidráulico no conserva una fuga.', '{0} consecutive post-closing measurements within the normal range (simulated data), and the hydraulic balance no longer retains a leak.'),
  rule('{0} mediciones consecutivas posteriores al cierre dentro de lo normal, y el balance hidráulico no conserva una fuga.', '{0} consecutive post-closing measurements within the normal range, and the hydraulic balance no longer retains a leak.'),
  rule('El balance hidráulico sigue concluyendo una fuga tras el cierre (exceso de {0} L/s).', 'The hydraulic balance still concludes a leak after closing (excess of {0} L/s).'),
  rule('El balance hidráulico sigue concluyendo una fuga tras el cierre.', 'The hydraulic balance still concludes a leak after closing.'),
  rule('{0} mediciones consecutivas posteriores al cierre siguen fuera de lo normal: la reparación no resolvió el problema.', '{0} consecutive post-closing measurements are still out of the normal range: the repair did not solve the problem.'),
  rule('Se necesitan {0} mediciones consecutivas dentro de lo normal y hay {1}.', '{0} consecutive measurements within the normal range are needed and there are {1}.'),
  rule('La última medición sigue fuera de lo normal; con {0} seguidas se reabre el caso.', 'The latest measurement is still out of the normal range; with {0} in a row the case is reopened.'),
  rule('{0} medición(es) se descartaron por sensor defectuoso.', '{0} measurement(s) were discarded because of a faulty sensor.'),
  rule('Ruptura de enlace en bloque #{0}: previousHash no coincide con el hash del bloque anterior.', 'Broken link at block #{0}: previousHash does not match the hash of the previous block.'),
  rule('Evidencia adjunta alterada en bloque #{0} ({1}): su SHA-256 no coincide con evidenceHash.', 'Attached evidence altered at block #{0} ({1}): its SHA-256 does not match evidenceHash.'),
  rule('Integridad comprometida en bloque #{0} ({1}): el hash SHA-256 almacenado no coincide con el contenido del registro.', 'Integrity compromised at block #{0} ({1}): the stored SHA-256 hash does not match the record content.'),
  // Verificador
  rule('{0} bloque(s) íntegros.', '{0} block(s) intact.'),
  rule('Bloque #{0} coincide con el sello.', 'Block #{0} matches the seal.'),
  rule('{0} componentes íntegros.', '{0} components intact.'),
  rule('Componentes alterados u omitidos: {0}.', 'Altered or omitted components: {0}.'),
  rule('No hay WORK_ORDER_CLOSED para {0}.', 'There is no WORK_ORDER_CLOSED for {0}.'),
  rule('Hash recalculado {0}… distinto del sellado.', 'Recomputed hash {0}… differs from the sealed one.'),
  rule('{0}: {1} medición(es) posteriores al cierre (datos simulados); el verificador obtiene el mismo resultado.', '{0}: {1} measurement(s) after closing (simulated data); the verifier reaches the same result.'),
  rule('{0}: {1} medición(es) posteriores al cierre; el verificador obtiene el mismo resultado.', '{0}: {1} measurement(s) after closing; the verifier reaches the same result.'),
  rule('keyId recibo {0} / clave {1}', 'receipt keyId {0} / key {1}'),
  rule('Altura {0} verificada.', 'Height {0} verified.'),
  rule('altura {0} vs cierre #{1}', 'height {0} vs closing #{1}'),
  rule('recomputado con las lecturas selladas da {0} con {1} medición(es), no {2}', 'recomputed from the sealed readings gives {0} with {1} measurement(s), not {2}'),
  rule('el nodo {0} no figura en el expediente', 'node {0} is not in the dossier'),
  rule('el veredicto aparece antes del cierre de la orden', 'the verdict appears before the order closing'),
  rule('el veredicto no incluye las lecturas que lo sustentan', 'the verdict does not include the readings that support it'),
  rule('el corte de evidencia usado no coincide con el cierre sellado y la última lectura previa', 'the evidence cutoff used does not match the sealed closing and the last earlier reading'),
  // Órdenes y errores con valores
  rule('Checklist incompleto: faltan {0} paso(s) ({1}).', 'Checklist incomplete: {0} step(s) missing ({1}).'),
  rule('No se puede cerrar la orden: {~0}', 'The order cannot be closed: {0}'),
  rule('Demasiadas {0}. Espera {1} s antes de reintentar.', 'Too many {0}. Wait {1} s before retrying.'),
  rule('Categoría inválida: debe ser una de {0}.', 'Invalid category: it must be one of {0}.'),
  rule('Operación destructiva sin confirmar: envía la cabecera X-Aqua-Confirm: {0}.', 'Destructive operation not confirmed: send the header X-Aqua-Confirm: {0}.'),
  rule('Token de operación ausente, caducado o ya utilizado. Solicita uno nuevo reautenticándote.', 'Operation token missing, expired or already used. Request a new one by re-authenticating.'),
  rule('Operación NO ejecutada: no se pudo registrar su autorización en la auditoría.', 'Operation NOT performed: its authorization could not be recorded in the audit log.'),
  rule('El responsable no puede superar {0} caracteres.', 'The assignee cannot exceed {0} characters.'),
  rule('La imagen supera el máximo de {0} MB.', 'The image exceeds the maximum of {0} MB.'),
  rule('Error {0} del servidor.', 'Server error {0}.'),
  rule('Aqua Brain ({~0})', 'Aqua Brain ({0})'),
  rule('mode debe ser uno de: {0}.', 'mode must be one of: {0}.'),
  rule('Nodo desconocido: {0}.', 'Unknown node: {0}.'),
  rule('Snapshot rechazado: {~0}', 'Snapshot rejected: {0}'),
  rule('Sin fotografía precargada para {0}', 'No preloaded photograph for {0}'),
  rule('Fotografía subida: {0}', 'Uploaded photograph: {0}'),
];

const SENTENCE_SPLIT = /(?<=[.;])\s+(?=[A-ZÁÉÍÓÚÑ"«¿¡0-9])/;

const PRIORITY_SUFFIX = /^(.+) \((Crítica|Alta|Media|Baja)\)$/s;

function translate(text: string, depth: number): string {
  const direct = EXACT[text];
  if (direct !== undefined) return direct;
  const withPriority = depth < 4 ? text.match(PRIORITY_SUFFIX) : null;
  if (withPriority) return `${translate(withPriority[1], depth + 1)} (${EXACT[withPriority[2]]})`;
  for (const r of RULES) {
    const m = text.match(r.re);
    if (!m) continue;
    return r.en.replace(/\{(\d)\}/g, (_all, i: string) => {
      const raw = m[Number(i) + 1] ?? '';
      return depth < 4 ? translate(raw, depth + 1) : raw;
    });
  }
  if (depth < 3 && SENTENCE_SPLIT.test(text)) {
    const parts = text.split(SENTENCE_SPLIT);
    const out = parts.map((p) => translate(p, depth + 1));
    return out.join(' ');
  }
  return text;
}

/**
 * Texto del servidor o del motor, listo para mostrar. En español (o si no hay plantilla) devuelve el original.
 * Las capturas se traducen de forma recursiva; los nombres propios y las cifras no coinciden con ninguna plantilla y se conservan.
 */
export function tr(text: string | null | undefined): string {
  if (typeof text !== 'string' || text === '') return text ?? '';
  if (getLang() !== 'en') return text;
  return translate(text, 0);
}

export const trList = (items: readonly string[] | null | undefined): string[] => (items ?? []).map((s) => tr(s));

/** Versión sin consultar el idioma activo: para las pruebas y para auditar la cobertura. */
export const translateEngineText = (text: string): string => translate(text, 0);
