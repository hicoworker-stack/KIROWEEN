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
12. **Operaciones destructivas protegidas**: reset, demo e import exigen confirmación explícita y reautenticación, token de un solo uso y auditoría previa, y archivan el estado previo.
13. **Integridad no es autenticidad**: un ledger con cadena válida prueba integridad interna; la autenticidad exige una clave fijada por el verificador y la inmutabilidad nunca se garantiza.
14. **Integraciones sin validar se declaran**: Gemini (texto y visión) permanece "no validado" hasta probarse con credenciales reales; los endpoints simulados solo se usan en pruebas de manejo de errores.
15. **Identidad verificable**: ninguna acción de usuario se atribuye a un nombre declarado por el cliente; el actor sale de la sesión autenticada y los nombres declarados se guardan aparte como no verificados.
16. **Denegación por defecto**: toda ruta exige sesión y declara su permiso; los controles se aplican en el servidor, nunca solo en la interfaz.
17. **Operaciones destructivas**: solo ADMIN, con reautenticación, token de un solo uso, confirmación explícita, autorización auditada antes de ejecutar y copia del estado anterior; si algo falla, no se ejecutan.
18. **Límites de la auditoría**: la cadena de hashes y la firma local detectan alteraciones de terceros, no garantizan inmutabilidad frente a quien controla el servidor; no se debe afirmar lo contrario.
19. **Sin secretos en logs, archivos de datos ni respuestas**: contraseñas, tokens de sesión, CSRF, de operación, claves de IA y clave privada de sellado.
20. **Procedencia visible**: la interfaz rotula cada dato como medido, declarado, inferido, hipótesis de IA o simulado; una hipótesis nunca se presenta como hecho y un dato simulado nunca como dato de campo.
21. **Sin recuperación sin medición**: un punto no se muestra como recuperado hasta que existan mediciones reales posteriores al cierre de su orden.
