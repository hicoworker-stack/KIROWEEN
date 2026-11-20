import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createApp } from './src/server/app';

/**
 * Arranque del servidor. Toda la lógica de la API vive en src/server/app.ts (testeable sin red).
 * Un rechazo de promesa que se escape de una ruta no termina el proceso: se registra y el servidor sigue atendiendo.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[proceso] Promesa rechazada sin capturar (el servidor sigue en marcha):', reason instanceof Error ? reason.message : reason);
});

async function bootstrapServer() {
  const { app, authStore, setupCode } = await createApp();
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use('/src/assets', express.static(path.resolve(process.cwd(), 'dist/src/assets')));
    app.use(express.static(distPath));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  // Por defecto solo escucha en loopback. Para exponerlo (detrás de un proxy HTTPS) define HOST explícitamente.
  const host = process.env.HOST || '127.0.0.1';
  app.listen(port, host, () => {
    console.log(`Aqua Sentinel server listening on http://${host}:${port}`);
    if (!authStore.hasUsers()) {
      if (setupCode) {
        console.log('[seguridad] No hay usuarios. Para crear el primer administrador abre la aplicación e introduce este código de UN SOLO USO:');
        console.log(`[seguridad]   ${setupCode.code}   (válido hasta ${setupCode.expiresAt})`);
        console.log('[seguridad] Alternativa recomendada en producción: npm run auth -- create-admin <usuario>');
      } else {
        console.log('[seguridad] No hay usuarios y el asistente web está deshabilitado. Crea el primer administrador con: npm run auth -- create-admin <usuario>');
      }
    }
    if (isProd) console.log('[seguridad] Producción: usa HTTPS (proxy inverso) y define AQUA_TRUSTED_PROXIES si hay proxy. Las cookies de sesión llevan el atributo Secure.');
  });
}

bootstrapServer().catch((err) => {
  const known = err instanceof Error && ['SecurityConfigError', 'AuthStoreError'].includes(err.name);
  console.error(known ? `[arranque] ${(err as Error).message}` : 'Failed to start Aqua Sentinel server:', known ? '' : err);
  process.exit(1);
});
