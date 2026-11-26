import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HERO_COPY, HERO_LANGS } from './heroCopy';
import { DEFAULT_POSTER, DEFAULT_TITLE, NEUTRAL_POSTER, parseVideoConfig, parseVideoConfigFor, resolveVideoState, selectVideoVersion } from './introVideo';

/** REQ-PUB-03: el video explicativo se configura con un archivo y nunca se simula. */

test('REQ-PUB-05: cada idioma toma SOLO su versión; si falta, no hay video y la portada no lleva texto de otro idioma', () => {
  const cfg = { versions: { es: { src: '/videos/es.mp4', captions: '/videos/es.vtt', poster: '/images/es.jpg', title: 'Versión en español' }, en: null } };
  const es = parseVideoConfigFor(cfg, 'es');
  assert.equal(es.src, '/videos/es.mp4');
  assert.equal(es.captions, '/videos/es.vtt');
  const en = parseVideoConfigFor(cfg, 'en');
  assert.equal(en.src, null, 'sin versión en inglés no se usa la española');
  assert.equal(en.captions, null);
  assert.equal(en.enabled, false, 'ni siquiera se consulta al servidor');
  assert.equal(en.poster, NEUTRAL_POSTER, 'portada sin texto');
  assert.equal(resolveVideoState(en, null), 'soon');

  const both = { versions: { es: { src: '/videos/es.mp4' }, en: { src: '/videos/en.mp4', captions: '/videos/en.vtt' } } };
  assert.equal(parseVideoConfigFor(both, 'en').src, '/videos/en.mp4');
  assert.equal(parseVideoConfigFor(both, 'en').poster, NEUTRAL_POSTER, 'una versión inglesa sin portada propia no hereda la portada española');
  assert.equal(parseVideoConfigFor(both, 'es').src, '/videos/es.mp4');
  assert.equal(parseVideoConfigFor(both, 'es').poster, DEFAULT_POSTER);
});

test('REQ-PUB-05: el formato anterior (un solo video) es español salvo que declare otro idioma; los datos basura no dan video', () => {
  const legacy = { src: '/videos/demo.mp4' };
  assert.equal(parseVideoConfigFor(legacy, 'es').src, '/videos/demo.mp4');
  assert.equal(parseVideoConfigFor(legacy, 'en').src, null);
  assert.equal(parseVideoConfigFor({ src: '/videos/demo-en.mp4', lang: 'en' }, 'en').src, '/videos/demo-en.mp4');
  assert.equal(parseVideoConfigFor({ src: '/videos/demo-en.mp4', lang: 'en' }, 'es').src, null);
  for (const bad of [null, 'x', [], { versions: 'x' }, { versions: [] }, { versions: { en: 'x' } }, { versions: { en: [] } }]) assert.equal(selectVideoVersion(bad, 'en'), null, JSON.stringify(bad));
  assert.equal(parseVideoConfigFor({ versions: { es: { src: '../../etc/passwd.mp4' } } }, 'es').src, null, 'la validación de rutas sigue aplicando');
});

test('REQ-PUB-05: los textos del Hero existen en los dos idiomas y no se mezclan', () => {
  for (const lang of HERO_LANGS) {
    const c = HERO_COPY[lang];
    for (const v of [c.title, c.subtitle, ...Object.values(c.video)]) assert.ok(v.trim().length > 0);
  }
  assert.doesNotMatch(Object.values(HERO_COPY.en.video).join(' ') + HERO_COPY.en.title + HERO_COPY.en.subtitle, /[áéíóúñ¿¡]|video explicativo|próximamente/i, 'sin español en la versión inglesa');
  assert.match(HERO_COPY.en.video.soon, /English/);
});

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
  const srcs = new Set<string>();
  for (const lang of HERO_LANGS) {
    const parsed = parseVideoConfigFor(cfg, lang);
    assert.ok(fs.existsSync(path.join(root, 'public', parsed.poster)), `${lang}: existe la portada configurada`);
    if (!parsed.src) {
      assert.equal(parsed.enabled, false, `${lang}: sin versión publicada no hay video que pedir`);
      continue;
    }
    assert.ok(!parsed.external, `${lang}: video local`);
    assert.ok(!srcs.has(parsed.src), 'cada idioma tiene su propio archivo: nunca se reutiliza el de otro idioma');
    srcs.add(parsed.src);
    const file = path.join(root, 'public', parsed.src);
    // Un video activado debe existir (sin 404 ni reproducción simulada). Desactivarlo es válido aunque el archivo siga en el
    // repositorio: así se retira un video desactualizado sin borrarlo, y la interfaz muestra «próximamente».
    if (parsed.enabled) assert.ok(fs.existsSync(file), `${lang}: un video activado existe en el repositorio`);
    else assert.equal(resolveVideoState(parsed, 'video/mp4'), 'soon', `${lang}: un video desactivado se muestra como «próximamente», nunca se reproduce`);
    if (parsed.enabled) assert.ok(fs.statSync(file).size > 10_000, `${lang}: el archivo de video no está vacío`);
    if (parsed.captions) {
      const vtt = fs.readFileSync(path.join(root, 'public', parsed.captions), 'utf8');
      assert.match(vtt, /^WEBVTT\s/, `${lang}: los subtítulos configurados existen y son WebVTT`);
      assert.match(vtt, lang === 'es' ? /simulad/i : /simulated/i, `${lang}: la narración declara que los datos son simulados`);
    }
  }
  assert.ok(fs.existsSync(path.join(root, 'public', 'images', 'hero-network.svg')), 'existe la imagen del encabezado');
  assert.ok(fs.existsSync(path.join(root, 'public', 'videos')), 'existe la carpeta de videos');
  for (const svg of ['hero-network.svg', 'video-poster.svg']) {
    const text = fs.readFileSync(path.join(root, 'public', 'images', svg), 'utf8');
    assert.match(text, /^<svg[^>]+viewBox=/);
    assert.ok(!/<script|onload=|javascript:|href="http/i.test(text), `${svg} no incluye scripts ni enlaces externos`);
  }
});
