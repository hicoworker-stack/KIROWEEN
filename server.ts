import 'dotenv/config';
import './src/server/cliFlags';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createApp } from './src/server/app';
import { loadSecurityConfig } from './src/server/netSecurity';
import { DEFAULT_STATE_PATH } from './src/server/persistence';
import { ensureJudgeAccount } from './src/server/judgeAccount';
import { refreshStalePublicState, seedPublicDemo } from './src/server/publicDemo';

/**
 * Arranque del servidor. Toda la lógica de la API vive en src/server/app.ts (testeable sin red).
 * Un rechazo de promesa que se escape de una ruta no termina el proceso: se registra y el servidor sigue atendiendo.
 *
 * MODO PÚBLICO (--public o AQUA_PUBLIC_MODE=1): cualquiera puede explorar sin iniciar sesión, solo en lectura y con datos
 * de demostración en un estado separado (data/public-demo/). Ver el README, sección «Modo público».
 */
process.on('unhandledRejection', (reason) => {
  console.error('[proceso] Promesa rechazada sin capturar (el servidor sigue en marcha):', reason instanceof Error ? reason.message : reason);
});

async function bootstrapServer() {
  const publicMode = process.env.AQUA_PUBLIC_MODE === '1' || process.env.AQUA_PUBLIC_MODE === 'true';
  if (publicMode && process.env.AQUA_PUBLIC_KEEP_STATE !== '1' && refreshStalePublicState(DEFAULT_STATE_PATH)) {
    console.log('[modo público] El estado de la demostración tenía más de 12 h: se descartó para sembrarlo con datos frescos (AQUA_PUBLIC_KEEP_STATE=1 lo evita).');
  }

  const handle = await createApp();
  const { app, authStore, setupCode } = handle;
  const isProd = process.env.NODE_ENV === 'production';
  // Cuenta de evaluación (rol OPERATOR) definida solo por entorno; nunca se registra la contraseña.
  const judge = await ensureJudgeAccount(authStore, process.env);
  if (judge.status === 'created') console.log(`[evaluación] Cuenta de juez creada: @${judge.username} (rol OPERATOR). La contraseña viene de AQUA_JUDGE_PASSWORD.`);
  else if (judge.status === 'rejected') console.error(`[evaluación] ${judge.reason}`);

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
    if (publicMode) {
      console.log('[modo público] Activo: los visitantes pueden explorar SIN iniciar sesión, solo en lectura y con datos SIMULADOS.');
      console.log(`[modo público] Estado aislado en ${path.relative(process.cwd(), DEFAULT_STATE_PATH)}. Rutas sin sesión: GET /api/state, GET /api/events y GET /api/evidence/:sha256; todo lo demás sigue protegido.`);
      void seedPublicDemo({ authStore, cfg: loadSecurityConfig(process.env), port, host, log: (m) => console.log(m) })
        .then((r) => {
          if (r.seeded) console.log(`[modo público] Demostración lista: abre http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
          else console.log(`[modo público] Sin sembrar: ${r.reason}`);
        })
        .catch((err) => console.error('[modo público] No se pudo sembrar la demostración:', err instanceof Error ? err.message : err));
    }
    if (!authStore.hasUsers()) {
      if (setupCode) {
        console.log('[seguridad] No hay usuarios. Para crear el primer administrador abre la aplicación e introduce este código de UN SOLO USO:');
        console.log(`[seguridad]   ${setupCode.code}   (válido hasta ${setupCode.expiresAt})`);
        console.log('[seguridad] Alternativa recomendada en producción: npm run auth -- create-admin <usuario>');
      } else if (!publicMode) {
        console.log('[seguridad] No hay usuarios y el asistente web está deshabilitado. Crea el primer administrador con: npm run auth -- create-admin <usuario>');
      }
    }
    if (isProd) console.log('[seguridad] Producción: usa HTTPS (proxy inverso) y define AQUA_TRUSTED_PROXIES si hay proxy. Las cookies de sesión llevan el atributo Secure.');
  });
}

bootstrapServer().catch((err) => {
  const known = err instanceof Error && ['SecurityConfigError', 'AuthStoreError', 'PublicModeError'].includes(err.name);
  console.error(known ? `[arranque] ${(err as Error).message}` : 'Failed to start Aqua Sentinel server:', known ? '' : err);
  process.exit(1);
});
