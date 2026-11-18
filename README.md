# Aqua Sentinel

**El cerebro operativo inteligente de los sistemas comunitarios de agua.**

Aqua Sentinel integra seis disciplinas operativas tradicionalmente separadas en un ciclo auditable de punta a punta:

`Dato → Anomalía → Correlación → Diagnóstico → Decisión → Orden de Trabajo → Verificación SHA-256`

## Arquitectura Integrada

1. **IoT & Ingesta (`src/core/deterministicEngine.ts`)**: Ingesta CSV y simulador de series temporales sintéticas (presión, caudal, nivel, turbidez, cloro libre y pH).
2. **Motor Determinista Independiente (`src/core/deterministicEngine.ts`)**: Reglas físicas e hidráulicas (`PRESSURE_DROP_LEAK`, `FLOW_OBSTRUCTION`, `SENSOR_PHYSICAL_IMPLAUSIBILITY`, `QUALITY_PARAMETER_ANOMALY`) y scoring de riesgo sin dependencia de LLM.
3. **Visión Multimodal (`src/server/aiProvider.ts`)**: Análisis fotográfico vía `@google/genai` (`gemini-4-hydrogen`) en servidor, con separador epistémico estricto entre *observado*, *inferido*, *no determinable* y *datos faltantes*, más adaptador de respaldo determinista.
4. **Geointeligencia (`src/components/NetworkMap.tsx`)**: Mapa hidráulico interactivo de la red comunitaria sintética *San Cristóbal de las Aguas*.
5. **Aqua Brain (`src/components/AquaBrainView.tsx`)**: Correlación multi-evidencia, hipótesis alternativas, incertidumbre calibrada y autorización humana (Aceptar / Modificar / Rechazar).
6. **Smart Work Orders & Trust Ledger (`src/core/cryptoLedger.ts`)**: Órdenes de trabajo trazables y registro append-only con encadenamiento criptográfico SHA-256 verificable, más persistencia offline en IndexedDB (`src/core/offlineStore.ts`).

## Estructura Kiro Spec-Driven (`.kiro/`)

- `.kiro/specs/`: Especificaciones de arquitectura, ingesta, motor determinista, Aqua Brain y Trust Ledger.
- `.kiro/steering/water-domain-rules.md`: Reglas de dominio hídrico e integridad epistémica.
- `.kiro/hooks/verify-integrity.json`: Hook de verificación continua (pruebas unitarias, TypeScript y bundle de producción).

## Ejecución y Pruebas

```bash
# Instalar dependencias
npm install

# Ejecutar pruebas unitarias (motor determinista + SHA-256 Trust Ledger)
npx --yes tsx --test src/core/deterministicEngine.test.ts src/core/cryptoLedger.test.ts

# Verificación de tipos TypeScript
npm run lint

# Desarrollo (Express + Vite en puerto 3000)
npm run dev

# Producción
npm run build
npm start
```

## Variables de Entorno

- `GEMINI_API_KEY` (opcional): Si está configurada en servidor, habilita análisis multimodal y razonamiento en vivo con `gemini-4-hydrogen`. Sin clave externa, la aplicación opera completamente mediante el adaptador de respaldo declarado explícitamente en la interfaz.

## M-10 y capacidades Frankenstein (Kiroween 2026)
- **Demo reproducible sin servicios externos**: bot�n "Demostraci�n Guiada" (`POST /api/demo/frankenstein`). Todas las lecturas son sint�ticas y se rotulan como tales.
- **Forense hidr�ulica**: balance de masa + presi�n + foto ? tramo sospechoso y p�rdida estimada (L/s, m�/d�a).
- **Concordancia multimodal**: sensores, foto y topolog�a; el conflicto limita la confianza.
- **Expediente verificable**: desc�rgalo desde una orden cerrada y val�dalo offline con `npm run verify:dossier -- <archivo>`.
- **�rdenes**: responsable, checklist y foto de cierre (SHA-256) obligatorios para cerrar.
- **Limitaciones**: Gemini en vivo no se pudo validar sin clave (la sonda en Integraciones lo comprueba); los adaptadores AWS son simulados; la persistencia es un archivo local (usa `AQUA_STATE_PATH` y el snapshot exportable en entornos ef�meros).
