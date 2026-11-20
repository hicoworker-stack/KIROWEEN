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
  console.error('[proceso] Promesa rechazada sin capturar (el servidor sigue en marcha):', reason);
});

async function bootstrapServer() {
  const { app } = await createApp();
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
  const host = process.env.HOST || '0.0.0.0';
  app.listen(port, host, () => {
    console.log(`Aqua Sentinel server listening on http://${host}:${port}`);
    if (isProd && !process.env.AQUA_ADMIN_TOKEN && process.env.AQUA_ALLOW_DESTRUCTIVE !== '1') {
      console.log('[seguridad] Producción sin AQUA_ADMIN_TOKEN: reset, demo e import están deshabilitados. Para una demo desplegada, define AQUA_ADMIN_TOKEN (recomendado) o AQUA_ALLOW_DESTRUCTIVE=1.');
    }
    console.log('[seguridad] El resto de la API no tiene autenticación de usuarios: no la expongas a internet sin un proxy que la proteja.');
  });
}

bootstrapServer().catch((err) => {
  console.error('Failed to start Aqua Sentinel server:', err);
  process.exit(1);
});
