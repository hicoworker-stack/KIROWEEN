# Especificación 04: Aqua Brain & Capa de Abstracción IA

## 1. Abstracción de Proveedores (`src/server/aiProvider.ts`)
- Interfaz común `AIProvider` con métodos `analyzeVisionEvidence()` y `synthesizeDiagnosis()`.
- **Proveedor Primario**: `GeminiProvider` usando `@google/genai` en servidor (`process.env.GEMINI_API_KEY`) con timeout acotado y enriquecimiento asíncrono no bloqueante.
- **Adaptador de Respaldo**: `DeterministicFallbackAdapter` utilizado automáticamente si no existe credencial, ocurre timeout o la red falla, clasificando explícitamente `fallbackReason` (`missing_key | timeout | api_error | no_image`) y nunca disfrazado de respuesta LLM.
- **Adaptador AWS Bedrock**: Definido como interfaz desacoplada; reporta estado real `No configurado` cuando no existen credenciales AWS.

## 2. Guardrails Epistémicos Obligatorios
- Prohibido inventar mediciones numéricas no presentes en el payload de sensores.
- Prohibido confirmar contaminación biológica o química únicamente por fotografía; debe exigir análisis fisicoquímico o laboratorio cuando aplique.
- Toda salida debe separar: `observed` (hechos directos), `inferred` (correlación), `uncertain` (lo no determinable) y `missingData` (datos faltantes).

## 3. Requisitos Formales y Trazabilidad
- **REQ-AI-01**: Clasificar honestamente el estado de enriquecimiento (`pending | live | fallback`) y el motivo real de respaldo (`missing_key | timeout | api_error | no_image`).
- **REQ-AI-09**: Sincronizar el panel de Visión Multimodal con la evidencia fotográfica del nodo activo y mantener separación epistémica estricta.
- **REQ-AI-10**: La autoridad final es de la persona: `IncidentsView` solo ofrece aceptar, cambiar o descartar la recomendación a quien tiene el permiso `diagnosis:decide` y el servidor lo exige igualmente.

| Requisito | Implementación | Prueba / Verificación |
| --- | --- | --- |
| `REQ-AI-01` | `src/server/aiProvider.ts`, `server.ts`, `src/core/types.ts` | `src/server/aiProvider.test.ts` |
| `REQ-AI-09` | `src/components/VisionIntelligenceView.tsx` | `src/ui/traceability.test.tsx` |
| `REQ-AI-10` | `src/components/IncidentsView.tsx`, `src/server/app.ts` | `src/ui/views.test.tsx`, `src/server/security.authz.test.ts` |

