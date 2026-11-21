import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_POSTER, DEFAULT_TITLE, parseVideoConfig, resolveVideoState } from './introVideo';

/** REQ-PUB-03: el video explicativo se configura con un archivo y nunca se simula. */

test('REQ-PUB-03: una configuración válida con video local se acepta', () => {
  const c = parseVideoConfig({ src: '/videos/aqua-sentinel-explicativo.mp4', poster: '/images/video-poster.svg', title: 'Mi video', captions: '/videos/es.vtt' });
  assert.deepEqual(c, { src: '/videos/aqua-sentinel-explicativo.mp4', poster: '/images/video-poster.svg', title: 'Mi video', captions: '/videos/es.vtt', external: false, enabled: true });
  assert.equal(parseVideoConfig({ src: '/videos/sub/demo.webm' }).src, '/videos/sub/demo.webm');
});

test('REQ-PUB-03: sin video (o con datos basura) la configuración queda en "próximamente" con portada y título por defecto', () => {
  for (const raw of [undefined, null, 5, 'texto', [], {}, { src: null }, { src: '' }, { src: 42 }]) {
    const c = parseVideoConfig(raw);
    assert.equal(c.src, null);
    assert.equal(c.poster, DEFAULT_POSTER);
    assert.equal(c.title, DEFAULT_TITLE);
    assert.equal(c.captions, null);
  }
});

test('REQ-PUB-03: se rechazan rutas peligrosas, esquemas inseguros y tipos no admitidos', () => {
  const bad = [
    '/videos/../../etc/passwd.mp4', '/videos/./x.mp4', '/otra/ruta/x.mp4', 'videos/x.mp4', '//evil.example/x.mp4', '/videos/x.exe', '/videos/x.mp4?x=1', '/videos/x y.mp4', '/videos/x.mp4#a',
    'javascript:alert(1)', 'data:video/mp4;base64,AAAA', 'file:///C:/x.mp4', 'http://evil.example/x.mp4', 'ftp://evil.example/x.mp4', 'https://user:pass@evil.example/x.mp4', 'https://evil.example/x.html',
  ];
  for (const src of bad) assert.equal(parseVideoConfig({ src }).src, null, src);
  assert.equal(parseVideoConfig({ src: '/videos/ok.mp4', poster: '/images/../secreto.svg' }).poster, DEFAULT_POSTER);
  assert.equal(parseVideoConfig({ src: '/videos/ok.mp4', poster: 'https://evil.example/p.png' }).poster, DEFAULT_POSTER);
  assert.equal(parseVideoConfig({ src: '/videos/ok.mp4', poster: '/images/p.html' }).poster, DEFAULT_POSTER);
  assert.equal(parseVideoConfig({ src: '/videos/ok.mp4', captions: '/videos/x.js' }).captions, null);
  assert.equal(parseVideoConfig({ title: 'a\nb\u0000c' + 'x'.repeat(300) }).title.length <= 120, true);
  assert.ok(!/[\u0000-\u001f]/.test(parseVideoConfig({ title: 'a\nb' }).title));
});

test('REQ-PUB-03: una URL https externa se admite (la CSP decide si el origen está autorizado) y se marca como externa', () => {
  const c = parseVideoConfig({ src: 'https://cdn.ejemplo.org/video/demo.mp4' });
  assert.equal(c.src, 'https://cdn.ejemplo.org/video/demo.mp4');
  assert.equal(c.external, true);
});

test('REQ-PUB-03: solo se considera que hay video si el servidor lo entrega como video; el index.html que responde a cualquier ruta NO cuenta', () => {
  const local = parseVideoConfig({ src: '/videos/aqua-sentinel-explicativo.mp4' });
  assert.equal(resolveVideoState(local, 'video/mp4'), 'ready');
  assert.equal(resolveVideoState(local, 'video/webm'), 'ready');
  assert.equal(resolveVideoState(local, 'text/html; charset=utf-8'), 'soon', 'el servidor responde 200 con la aplicación para rutas inexistentes');
  assert.equal(resolveVideoState(local, 'application/json'), 'soon');
  assert.equal(resolveVideoState(local, null), 'soon');
  assert.equal(resolveVideoState(local, 'error'), 'soon');
  assert.equal(resolveVideoState(parseVideoConfig({}), 'video/mp4'), 'soon', 'sin src nunca hay video');
  assert.equal(resolveVideoState(parseVideoConfig({ src: '/videos/ok.mp4', enabled: false }), 'video/mp4'), 'soon', '"enabled": false manda sobre todo');
  assert.equal(parseVideoConfig({ src: '/videos/ok.mp4', enabled: 'no' }).enabled, true, 'solo false desactiva');
  assert.equal(resolveVideoState(parseVideoConfig({ src: 'https://cdn.ejemplo.org/x.mp4' }), 'error'), 'ready');
});

test('REQ-PUB-03: la estructura de archivos para publicar el video existe en el repositorio y su configuración por defecto es válida', () => {
  const root = process.cwd();
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'public', 'config', 'intro-video.json'), 'utf8'));
  const parsed = parseVideoConfig(cfg);
  assert.equal(parsed.src, '/videos/aqua-sentinel-explicativo.mp4');
  const file = path.join(root, 'public', parsed.src!);
  assert.equal(parsed.enabled, fs.existsSync(file), 'enabled solo es true si el archivo de video existe (sin 404 ni reproducción simulada)');
  if (parsed.enabled) assert.ok(fs.statSync(file).size > 10_000, 'el archivo de video no está vacío');
  assert.ok(fs.existsSync(path.join(root, 'public', parsed.poster)), 'existe la portada configurada');
  assert.ok(fs.existsSync(path.join(root, 'public', 'images', 'hero-network.svg')), 'existe la imagen del encabezado');
  assert.ok(fs.existsSync(path.join(root, 'public', 'videos')), 'existe la carpeta de videos');
  for (const svg of ['hero-network.svg', 'video-poster.svg']) {
    const text = fs.readFileSync(path.join(root, 'public', 'images', svg), 'utf8');
    assert.match(text, /^<svg[^>]+viewBox=/);
    assert.ok(!/<script|onload=|javascript:|href="http/i.test(text), `${svg} no incluye scripts ni enlaces externos`);
  }
});
