# Reglas de Dominio Hídrico y Estándares Técnicos (Steering)

1. **Honestidad Epistémica**: Distingue siempre entre evidencia medida, inferencia algorítmica, incertidumbre y datos faltantes.
2. **Transparencia de Datos Sintéticos**: Todos los sensores pre-cargados de la red comunitaria *San Cristóbal de las Aguas* deben etiquetarse explícitamente como datos sintéticos de demostración.
3. **Independencia Operativa**: Ningún flujo crítico (detección de fugas, priorización, órdenes de trabajo, ledger SHA-256 o modo offline) puede bloquearse por ausencia de API keys o conectividad externa.
4. **Cero Afirmaciones No Validadas**: No declarar ahorros reales de agua ni certificaciones sanitarias automáticas sin validación de campo.
5. **Integridad de Código**: Lógica pura desacoplada en `src/core/`, cubierta por pruebas `node:test`, tipado estricto TypeScript y verificación continua mediante `tsc --noEmit` y `vite build`.
6. **Sin interpretación falsa de imágenes**: un adaptador sin visión real nunca describe el contenido de una foto; solo las imágenes de demostración empaquetadas llevan anotación predefinida y se rotulan así.
7. **Conflicto entre canales**: si sensores, foto y topología se contradicen, se reporta el conflicto y se limita la confianza; nunca se promedia.
8. **Cierre verificable**: una orden solo se cierra con checklist completo y foto sellada por SHA-256 en el Trust Ledger.
9. **Estimaciones declaradas**: el caudal perdido es una estimación del balance de masa; la resolución espacial es el tramo entre dos medidores.
