# Especificación 11: Corrección de F1, F2 y F3 (auditoría posterior a la Fase 2)

Objetivo: cerrar en el servidor los tres defectos de integridad que la interfaz solo hacía visibles. Ninguno cambia permisos, sesiones ni el formato del ledger: se añaden un canal de concordancia, un campo opcional del nodo y una acción nueva del ledger.

## 1. Defectos y corrección
- **F1. Un reporte declarado contaba como «sensores».** Un reporte de campo sincronizado sin conexión se diagnosticaba con el canal `sensores` y una regla de sensor (`PRESSURE_DROP_LEAK`, etc.). Ahora el canal es `reporte` (procedencia DECLARADO), la regla es `FIELD_REPORT_DECLARED` y el respaldo por defecto de un diagnóstico sin concordancia tampoco dice «sensores». El nivel de respaldo sigue sin subir por un reporte: solo lo suben canales adicionales que coinciden.
- **F2. Cerrar una orden escribía una lectura «restaurada».** Al cerrar, el servidor ya no fabrica ninguna lectura ni declara el punto estable. El nodo recibe `pendingVerification: { workOrderId, closedAt }` y conserva la última medición de antes del cierre. La primera medición con marca temporal posterior al cierre quita la marca y deja en el Trust Ledger la acción `POST_CLOSURE_MEASUREMENT` con `recovered: true` (recuperación medida) o `false` (la anomalía persiste). Mientras el punto está pendiente, el balance de red no abre incidentes con sus lecturas anteriores al cierre. Una lectura rezagada con marca anterior al cierre no verifica nada.
- **F3. El flujo SSE sobrevivía a la caducidad por inactividad.** `isSessionValid` (validación pasiva, que no renueva la sesión) ahora comprueba también la inactividad. El flujo de eventos la consulta en cada latido y antes de cada difusión de estado; una sesión caducada deja de recibir estado y su flujo se cierra. El latido es de 15 s por defecto (`AQUA_SSE_PING_MS`, entre 200 ms y 15 s).

## 2. Requisitos
- **REQ-FIX-01**: Un reporte de campo declarado nunca se cuenta ni se rotula como lectura de sensores en la concordancia, en las reglas ni en el diagnóstico.
- **REQ-FIX-02**: Cerrar una orden no escribe lecturas ni declara recuperación; solo una medición posterior al cierre confirma o descarta la recuperación, y esa verificación queda en el Trust Ledger.
- **REQ-FIX-03**: Un flujo de eventos con sesión deja de recibir estado y se cierra cuando la sesión caduca, también por inactividad, sin que mantenerlo abierto cuente como actividad.

## 3. Compatibilidad y límites
- Los estados guardados antes de la corrección pueden contener lecturas `restored` y diagnósticos con `sensores` en un reporte declarado. La interfaz los sigue tratando como antes: pendiente de verificación y «Reporte de campo (declarado)» con aviso.
- En la demostración, la medición posterior al cierre también es SIMULADA. La regla 4 se mantiene: ningún ahorro de agua se declara real sin validación de campo.

| Requisito | Implementación | Prueba / Verificación |
| --- | --- | --- |
| `REQ-FIX-01` | `src/core/evidenceConcordance.ts`, `src/core/diagnosisTemplates.ts`, `src/core/types.ts`, `src/server/app.ts`, `src/server/aiProvider.ts`, `src/ui/vocab.ts` | `src/core/evidenceConcordance.test.ts`, `src/server/integrityFixes.test.ts`, `src/ui/vocab.test.ts` |
| `REQ-FIX-02` | `src/server/app.ts`, `src/core/types.ts`, `src/ui/vocab.ts`, `src/components/MapView.tsx` | `src/server/integrityFixes.test.ts`, `src/server/e2e.test.ts`, `src/ui/vocab.test.ts` |
| `REQ-FIX-03` | `src/server/authStore.ts`, `src/server/app.ts` | `src/server/integrityFixes.test.ts` |
