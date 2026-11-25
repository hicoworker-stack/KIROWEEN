import { tr } from '../ui/engineText';
import { t } from '../ui/i18n';
import React, { useCallback, useEffect, useState } from 'react';
import { Database, Download, KeyRound, ShieldAlert, Upload, Zap } from 'lucide-react';
import { destructiveFetch, readServerMessage } from '../client/adminFetch';
import { apiFetch } from '../client/api';

interface Health {
  aiProvider: string;
  aiMode: 'gemini-live' | 'fallback-adapter';
  geminiModel: string;
  geminiModelNote?: string;
  visionProvider?: string;
  geminiHealth: { lastSuccessAt: string | null; lastErrorAt: string | null; lastError: string | null; verified: boolean };
  persistence: {
    kind: string;
    statePath: string;
    writable: boolean;
    ephemeralRisk: 'alto' | 'medio' | 'bajo';
    note: string;
    mode?: 'disk' | 'memory-only';
    lastError?: string | null;
  };
  integrity?: { status: 'ok' | 'degraded' | 'compromised'; issues: string[] };
  seal?: { keyId: string; keyPersistence: 'file' | 'env' | 'ephemeral' };
  security?: { production: boolean; destructiveOps: string; audit: { status: 'ok' | 'degraded' | 'compromised'; failedWrites: number; count: number }; activeSessions: number; rateLimiter: string };
  ledgerCount: number;
  ledgerHeadHash: string | null;
}

interface ProbeResult {
  configured: boolean;
  ok: boolean;
  model: string;
  latencyMs?: number;
  error?: string;
}

export const OperationsHealthPanel: React.FC<{ onStateChanged: () => void; isAdmin?: boolean }> = ({ onStateChanged, isAdmin = false }) => {
  const [health, setHealth] = useState<Health | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHealth(await res.json());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t('Sin respuesta del servidor.', 'No response from the server.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    try {
      const res = await apiFetch('/api/ai/probe', { method: 'POST' });
      setProbe(await res.json());
      await load();
    } catch {
      setProbe({ configured: false, ok: false, model: health?.geminiModel ?? '?', error: t('No se pudo contactar al servidor.', 'The server could not be reached.') });
    } finally {
      setProbing(false);
    }
  };

  const exportSnapshot = async () => {
    setMessage(null);
    try {
      const res = await apiFetch('/api/state/export');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `aqua-sentinel-snapshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMessage({ kind: 'ok', text: t('Snapshot exportado con fotos de cierre y expedientes sellados incluidos.', 'Snapshot exported with closing photos and sealed dossiers included.') });
    } catch (e) {
      setMessage({ kind: 'error', text: t(`No se pudo exportar: ${e instanceof Error ? e.message : 'error'}`, `Export failed: ${e instanceof Error ? e.message : 'error'}`) });
    }
  };

  const importSnapshot = async (file: File) => {
    setMessage(null);
    try {
      const body = JSON.parse(await file.text());
      const res = await destructiveFetch('/api/state/import', 'import', { body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ kind: 'error', text: `Snapshot rejected: ${(data.errors ?? [data.error ?? (await readServerMessage(res, 'error'))]).join(' · ')}` });
        return;
      }
      setMessage({ kind: 'ok', text: t('Snapshot restaurado tras verificar cadena, coherencia órdenes-ledger, sellos y anclas. El estado anterior se archivó en el servidor.', 'Snapshot restored after checking the chain, order-ledger consistency, seals and anchors. The previous state was archived on the server.') });
      onStateChanged();
      await load();
    } catch {
      setMessage({ kind: 'error', text: t('El archivo no es un snapshot JSON válido.', 'The file is not a valid JSON snapshot.') });
    }
  };

  const riskClass =
    health?.persistence.ephemeralRisk === 'alto' ? 'text-rose-300' : health?.persistence.ephemeralRisk === 'medio' ? 'text-amber-300' : 'text-emerald-300';
  const memoryOnly = health?.persistence.mode === 'memory-only';

  return (
    <section className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 space-y-4" aria-labelledby="ops-health-title">
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4 text-cyan-400" />
        <h3 id="ops-health-title" className="text-base font-semibold text-white">{t('Estado real de IA, persistencia y sellado', 'Actual AI, persistence and sealing status')}</h3>
      </div>

      {loadError && <p role="alert" className="text-xs text-rose-300">{t('No se pudo leer /api/health', 'Could not read /api/health')}: {tr(loadError)}</p>}
      {!health && !loadError && <p className="text-xs text-slate-400">{t('Cargando estado del servidor…', 'Loading server status…')}</p>}

      {health && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
          <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2">
            <div className="text-slate-400">{t('Gemini (texto) y visión', 'Gemini (text) and vision')}</div>
            <div className="font-semibold text-cyan-300">{tr(health.aiProvider)}</div>
            <div className="text-slate-400 font-mono">{t('Modelo', 'Model')}: {health.geminiModel}</div>
            {health.visionProvider && <div className="text-slate-300">{t('Visión', 'Vision')}: {tr(health.visionProvider)}</div>}
            {health.geminiModelNote && <div className="text-amber-300/90">{tr(health.geminiModelNote)}</div>}
            {health.geminiHealth.lastError && !health.geminiHealth.verified && (
              <div className="text-amber-300 break-words">{t('Último error', 'Last error')}: {tr(health.geminiHealth.lastError)}</div>
            )}
            <button
              type="button"
              onClick={runProbe}
              hidden={!isAdmin}
              disabled={probing || !isAdmin}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-[#0F2736] hover:bg-[#143349] text-cyan-300 border border-[#234C66] rounded-lg cursor-pointer disabled:opacity-50"
            >
              <Zap className="w-3.5 h-3.5" />
              {probing ? t('Probando…', 'Testing…') : t('Probar Gemini ahora', 'Test Gemini now')}
            </button>
            {probe && (
              <p role="status" className={probe.ok ? 'text-emerald-300' : 'text-amber-300'}>
                {probe.ok
                  ? t(`Respuesta real de ${probe.model} en ${probe.latencyMs} ms.`, `Real response from ${probe.model} in ${probe.latencyMs} ms.`)
                  : !probe.configured
                    ? t('Sin GEMINI_API_KEY: el sistema opera con el adaptador determinista y las fotografías quedan no analizadas.', 'No GEMINI_API_KEY: the system runs on the deterministic adapter and photographs stay not analyzed.')
                    : t(`Falló la llamada a ${probe.model}: ${tr(probe.error)}`, `The call to ${probe.model} failed: ${tr(probe.error)}`)}
              </p>
            )}
          </div>

          <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2">
            <div className="text-slate-400">{t('Persistencia', 'Persistence')}</div>
            <div className={`font-semibold ${memoryOnly ? 'text-rose-300' : 'text-slate-100'}`}>
              {memoryOnly ? t('SOLO MEMORIA: el último guardado en disco falló', 'MEMORY ONLY: the last save to disk failed') : t(`Archivo local del servidor (${health.persistence.writable ? 'escritura OK' : 'SIN permiso de escritura'})`, `Local server file (${health.persistence.writable ? 'write OK' : 'NO write permission'})`)}
            </div>
            {memoryOnly && health.persistence.lastError && <div className="text-rose-300 break-words">{health.persistence.lastError}</div>}
            <div className="text-slate-400 font-mono break-all">{health.persistence.statePath}</div>
            <div className={riskClass}>{t('Riesgo de pérdida por entorno efímero', 'Risk of loss from an ephemeral environment')}: {t(health.persistence.ephemeralRisk, ({ alto: 'high', medio: 'medium', bajo: 'low' } as Record<string, string>)[health.persistence.ephemeralRisk] ?? health.persistence.ephemeralRisk)}. {tr(health.persistence.note)}</div>
            <div className="flex flex-wrap gap-2 pt-1" hidden={!isAdmin}>
              <button
                type="button"
                onClick={exportSnapshot}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-[#0F2736] hover:bg-[#143349] text-cyan-300 border border-[#234C66] rounded-lg cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                {t('Exportar snapshot', 'Export snapshot')}
              </button>
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-[#0F2736] hover:bg-[#143349] text-cyan-300 border border-[#234C66] rounded-lg cursor-pointer focus-within:ring-2 focus-within:ring-cyan-400">
                <Upload className="w-3.5 h-3.5" />
                {t('Importar snapshot', 'Import snapshot')}
                <input
                  type="file"
                  accept="application/json,.json"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void importSnapshot(f);
                  }}
                />
              </label>
            </div>
            {message && (
              <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'text-rose-300' : 'text-emerald-300'}>
                {message.text}
              </p>
            )}
          </div>

          <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2 lg:col-span-2">
            <div className="flex items-center gap-1.5 text-slate-400">
              <KeyRound className="w-3.5 h-3.5" />
              {t('Sellado de expedientes (Ed25519) e integridad', 'Dossier sealing (Ed25519) and integrity')}
            </div>
            {health.seal && (
              <div className="space-y-1">
                <div>
                  {t('Huella de la clave de sellado (anótala por un canal independiente para poder comprobar la autenticidad del emisor):', 'Sealing key fingerprint (note it down through an independent channel so you can check the issuer authenticity):')}
                </div>
                <div className="font-mono text-cyan-300 break-all select-all">{health.seal.keyId}</div>
                <div className={health.seal.keyPersistence === 'ephemeral' ? 'text-amber-300' : 'text-slate-400'}>
                  {health.seal.keyPersistence === 'ephemeral'
                    ? t('Clave EFÍMERA: se perderá al reiniciar y los recibos emitidos no podrán verificarse contra una clave futura.', 'EPHEMERAL key: it will be lost on restart and issued receipts cannot be verified against a future key.')
                    : health.seal.keyPersistence === 'env'
                      ? t('Clave inyectada por entorno.', 'Key injected through the environment.')
                      : t('Clave persistida junto al estado.', 'Key persisted alongside the state.')}
                </div>
              </div>
            )}
            {health.integrity && (
              <div className={`flex items-start gap-1.5 ${health.integrity.status === 'ok' ? 'text-emerald-300' : health.integrity.status === 'compromised' ? 'text-rose-300' : 'text-amber-300'}`}>
                <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  {t('Integridad del estado', 'State integrity')}: {health.integrity.status === 'ok' ? t('sin hallazgos', 'no findings') : health.integrity.status === 'compromised' ? t('COMPROMETIDA', 'COMPROMISED') : t('con avisos', 'with warnings')}
                  {health.integrity.issues.length > 0 && ` — ${health.integrity.issues.slice(0, 3).map((i) => tr(i)).join(' · ')}`}
                </span>
              </div>
            )}
            {health.security && (
              <div className="text-slate-400">
                {t('Operaciones destructivas (reset, demo, import)', 'Destructive operations (reset, demo, import)')}: {tr(health.security.destructiveOps)}.
                <div className={health.security.audit.status === 'ok' ? 'text-emerald-300' : health.security.audit.status === 'compromised' ? 'text-rose-300' : 'text-amber-300'}>
                  {t('Auditoría', 'Audit')}: {health.security.audit.status === 'ok' ? t('cadena verificada', 'chain verified') : health.security.audit.status === 'compromised' ? t('COMPROMETIDA', 'COMPROMISED') : t('con avisos', 'with warnings')} ({health.security.audit.count} {t('eventos', 'events')}
                  {health.security.audit.failedWrites > 0 ? t(`, ${health.security.audit.failedWrites} fallos de escritura`, `, ${health.security.audit.failedWrites} write failures`) : ''}). {t('Detecta alteraciones de terceros; no es inmutable frente a quien controla el servidor.', 'It detects tampering by third parties; it is not immutable against whoever controls the server.')}
                </div>
                <div>{t('Sesiones activas', 'Active sessions')}: {health.security.activeSessions}. {t('Límite de tasa', 'Rate limiter')}: {tr(health.security.rateLimiter)}.</div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
