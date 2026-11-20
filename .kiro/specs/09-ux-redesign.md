# Especificación 09: Rediseño de la experiencia de usuario (UX/UI)

Objetivo: que cualquier persona, sin formación técnica, entienda el estado de la red, identifique un problema y sepa qué hacer. El rediseño es solo de presentación: no cambia la API, la seguridad, la persistencia ni la lógica de negocio.

## 1. Estructura
- Cuatro apartados principales: Inicio, Mapa, Incidentes, Órdenes de trabajo. Todo lo técnico (series de sensores, evidencia visual, Trust Ledger, conexión e integraciones, demostración) vive en «Herramientas avanzadas», accesible desde el menú de usuario y desde enlaces contextuales.
- Cada pantalla responde: ¿qué pasa?, ¿qué significa?, ¿qué hago?
- Los flujos A-H: consultar el estado, identificar el incidente, entender por qué, ver las evidencias, aceptar la recomendación, generar la orden, registrar la intervención y comprobar la recuperación.

## 2. Requisitos
- **REQ-UX-01**: Lenguaje claro y cifras con contexto («lo normal aquí»). La urgencia se expresa con palabras, nunca con puntuaciones internas. Lo que requiere atención se ordena en «Qué hacer ahora».
- **REQ-UX-02**: Procedencia visible de cada dato: MEDIDO, DECLARADO, INFERIDO, HIPÓTESIS IA, SIMULADO. Una hipótesis nunca se presenta como hecho. Un reporte declarado por una persona nunca se muestra como lectura de sensores, aunque el servidor lo cuente así (defecto F1 de la auditoría, pendiente en el servidor).
- **REQ-UX-03**: Estados comprensibles: estable, requiere atención, crítico, pendiente de verificación y sin conexión, comunicados con color, símbolo y palabra. Un punto cuya última lectura es la «restaurada» al cerrar una orden se muestra como pendiente de verificación, no como estable (defecto F2, pendiente en el servidor).
- **REQ-UX-04**: Navegación principal de cuatro apartados con barra inferior en móvil, rutas en la URL (historial del navegador) y herramientas avanzadas sin eliminar ninguna capacidad ni endpoint.
- **REQ-UX-05**: Roles, adaptación y accesibilidad. La interfaz oculta o desactiva lo que el rol no puede hacer usando la misma matriz de permisos que el servidor, pero la autorización real sigue siendo la del servidor. Controles táctiles de al menos 44 px, foco visible, salto al contenido, texto alternativo, confirmación antes de operaciones sensibles, indicador de conexión y estados de carga y error.

## 3. Limitaciones declaradas
- F1, F2 y F3 siguen pendientes en el servidor: la interfaz los hace visibles (F1 y F2) pero no los corrige; F3 (flujo SSE tras expirar la sesión por inactividad) no tiene remedio en la interfaz.
- No existe pantalla de gestión de usuarios ni de consulta de la auditoría: sus endpoints existen, pero no se añadió interfaz nueva en esta etapa.
- Las pruebas automáticas cubren el vocabulario y la renderización de las vistas; la navegación real en navegador, el móvil y el modo sin conexión se validan a mano y no forman parte de `npm test`.

| Requisito | Implementación | Prueba / Verificación |
| --- | --- | --- |
| `REQ-UX-01` | `src/ui/vocab.ts`, `src/components/HomeView.tsx`, `src/components/IncidentsView.tsx` | `src/ui/vocab.test.ts`, `src/ui/views.test.tsx` |
| `REQ-UX-02` | `src/ui/vocab.ts`, `src/components/ui.tsx`, `src/components/IncidentsView.tsx` | `src/ui/vocab.test.ts`, `src/ui/views.test.tsx` |
| `REQ-UX-03` | `src/ui/vocab.ts`, `src/components/NetworkMap.tsx`, `src/components/MapView.tsx`, `src/components/WorkOrdersView.tsx` | `src/ui/vocab.test.ts`, `src/ui/views.test.tsx` |
| `REQ-UX-04` | `src/App.tsx`, `src/components/AppShell.tsx`, `src/components/AdvancedView.tsx` | `src/ui/vocab.test.ts`, `src/ui/views.test.tsx` |
| `REQ-UX-05` | `src/core/permissions.ts`, `src/components/ReportIssueSheet.tsx`, `src/components/AppShell.tsx`, `src/client/image.ts` | `src/ui/views.test.tsx`, `src/server/netSecurity.test.ts` |
