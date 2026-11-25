/**
 * Banderas de línea de comandos que deben aplicarse ANTES de que se evalúen los demás módulos del servidor
 * (por ejemplo, la ruta por defecto del estado depende del modo público). Se importa primero en server.ts y en el CLI.
 *
 *   --public   equivale a AQUA_PUBLIC_MODE=1 (ver src/server/publicMode.ts)
 */
if (process.argv.includes('--public')) process.env.AQUA_PUBLIC_MODE = '1';
if (process.argv.includes('--open')) process.env.AQUA_OPEN_ACCESS = '1';

export {};
