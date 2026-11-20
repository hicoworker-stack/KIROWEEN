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

10. **Sin confianza numérica sin calibración**: no se muestran porcentajes de confianza; se usa un nivel de respaldo (baja/media/alta/en_conflicto) derivado de canales realmente medidos y vinculados al incidente.
11. **Separación simulación/diagnóstico**: src/sim/ genera escenarios y verdad de terreno; src/core/ diagnostica y nunca importa src/sim/ (lo hace cumplir src/architecture.test.ts).
12. **Operaciones destructivas protegidas**: reset, demo e import exigen confirmación explícita y autorización (AQUA_ADMIN_TOKEN o habilitación expresa) y archivan el estado previo.
13. **Integridad no es autenticidad**: un ledger con cadena válida prueba integridad interna; la autenticidad exige una clave fijada por el verificador y la inmutabilidad nunca se garantiza.
14. **Integraciones sin validar se declaran**: Gemini (texto y visión) permanece "no validado" hasta probarse con credenciales reales; los endpoints simulados solo se usan en pruebas de manejo de errores.