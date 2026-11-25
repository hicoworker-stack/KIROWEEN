import { api, RunningServer, startServer } from '../src/server/testing/harness';
export { api };

/**
 * Arranca el servidor real (server.ts en un proceso aparte, directorio temporal) con las cuentas de prueba del arnés y la
 * sesión de administrador ya abierta. Es la misma infraestructura que usan las pruebas de extremo a extremo.
 */
export const startServerWithDefaults = (): Promise<RunningServer> => startServer();
