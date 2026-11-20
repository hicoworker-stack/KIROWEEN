import React, { useCallback, useEffect, useState } from 'react';
import { Database, Download, KeyRound, ShieldAlert, Upload, Zap } from 'lucide-react';
import { destructiveFetch, readServerMessage } from '../client/adminFetch';

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
  destructiveOps?: { requiresToken: boolean; enabledByEnv: boolean; production: boolean };
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

export const OperationsHealthPanel: React.FC<{ onStateChanged: () => void }> = ({ onStateChanged }) => {
  const [health, setHealth] = useState<Health | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHealth(await res.json());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Sin respuesta del servidor.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    try {
      const res = await fetch('/api/ai/probe', { method: 'POST' });
      setProbe(await res.json());
      await load();
    } catch {
      setProbe({ configured: false, ok: false, model: health?.geminiModel ?? '?', error: 'No se pudo contactar al servidor.' });
    } finally {
      setProbing(false);
    }
  };

  const exportSnapshot = async () => {
    setMessage(null);
    try {
      const res = await fetch('/api/state/export');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `aqua-sentinel-snapshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMessage({ kind: 'ok', text: 'Snapshot exportado con fotos de cierre y expedientes sellados incluidos.' });
    } catch (e) {
      setMessage({ kind: 'error', text: `No se pudo exportar: ${e instanceof Error ? e.message : 'error'}` });
    }
  };

  const importSnapshot = async (file: File) => {
    setMessage(null);
    try {
      const body = JSON.parse(await file.text());
      const res = await destructiveFetch('/api/state/import', 'import', { body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ kind: 'error', text: `Snapshot rechazado: ${(data.errors ?? [data.error ?? (await readServerMessage(res, 'error'))]).join(' · ')}` });
        return;
      }
      setMessage({ kind: 'ok', text: 'Snapshot restaurado tras verificar cadena, coherencia órdenes-ledger, sellos y anclas. El estado anterior se archivó en el servidor.' });
      onStateChanged();
      await load();
    } catch {
      setMessage({ kind: 'error', text: 'El archivo no es un snapshot JSON válido.' });
    }
  };

  const riskClass =
    health?.persistence.ephemeralRisk === 'alto' ? 'text-rose-300' : health?.persistence.ephemeralRisk === 'medio' ? 'text-amber-300' : 'text-emerald-300';
  const memoryOnly = health?.persistence.mode === 'memory-only';

  return (
    <section className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 space-y-4" aria-labelledby="ops-health-title">
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4 text-cyan-400" />
        <h3 id="ops-health-title" className="text-base font-semibold text-white">Estado real de IA, persistencia y sellado</h3>
      </div>

      {loadError && <p role="alert" className="text-xs text-rose-300">No se pudo leer /api/health: {loadError}</p>}
      {!health && !loadError && <p className="text-xs text-slate-400">Cargando estado del servidor…</p>}

      {health && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
          <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2">
            <div className="text-slate-400">Gemini (texto) y visión</div>
            <div className="font-semibold text-cyan-300">{health.aiProvider}</div>
            <div className="text-slate-400 font-mono">Modelo: {health.geminiModel}</div>
            {health.visionProvider && <div className="text-slate-300">Visión: {health.visionProvider}</div>}
            {health.geminiModelNote && <div className="text-amber-300/90">{health.geminiModelNote}</div>}
            {health.geminiHealth.lastError && !health.geminiHealth.verified && (
              <div className="text-amber-300 break-words">Último error: {health.geminiHealth.lastError}</div>
            )}
            <button
              type="button"
              onClick={runProbe}
              disabled={probing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-[#0F2736] hover:bg-[#143349] text-cyan-300 border border-[#234C66] rounded-lg cursor-pointer disabled:opacity-50"
            >
              <Zap className="w-3.5 h-3.5" />
              {probing ? 'Probando…' : 'Probar Gemini ahora'}
            </button>
            {probe && (
              <p role="status" className={probe.ok ? 'text-emerald-300' : 'text-amber-300'}>
                {probe.ok
                  ? `Respuesta real de ${probe.model} en ${probe.latencyMs} ms.`
                  : !probe.configured
                    ? 'Sin GEMINI_API_KEY: el sistema opera con el adaptador determinista y las fotografías quedan no analizadas.'
                    : `Falló la llamada a ${probe.model}: ${probe.error}`}
              </p>
            )}
          </div>

          <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2">
            <div className="text-slate-400">Persistencia</div>
            <div className={`font-semibold ${memoryOnly ? 'text-rose-300' : 'text-slate-100'}`}>
              {memoryOnly ? 'SOLO MEMORIA: el último guardado en disco falló' : `Archivo local del servidor (${health.persistence.writable ? 'escritura OK' : 'SIN permiso de escritura'})`}
            </div>
            {memoryOnly && health.persistence.lastError && <div className="text-rose-300 break-words">{health.persistence.lastError}</div>}
            <div className="text-slate-400 font-mono break-all">{health.persistence.statePath}</div>
            <div className={riskClass}>Riesgo de pérdida por entorno efímero: {health.persistence.ephemeralRisk}. {health.persistence.note}</div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={exportSnapshot}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-[#0F2736] hover:bg-[#143349] text-cyan-300 border border-[#234C66] rounded-lg cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Exportar snapshot
              </button>
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-[#0F2736] hover:bg-[#143349] text-cyan-300 border border-[#234C66] rounded-lg cursor-pointer focus-within:ring-2 focus-within:ring-cyan-400">
                <Upload className="w-3.5 h-3.5" />
                Importar snapshot
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
              Sellado de expedientes (Ed25519) e integridad
            </div>
            {health.seal && (
              <div className="space-y-1">
                <div>
                  Huella de la clave de sellado (anótala por un canal independiente para poder comprobar la autenticidad del emisor):
                </div>
                <div className="font-mono text-cyan-300 break-all select-all">{health.seal.keyId}</div>
                <div className={health.seal.keyPersistence === 'ephemeral' ? 'text-amber-300' : 'text-slate-400'}>
                  {health.seal.keyPersistence === 'ephemeral'
                    ? 'Clave EFÍMERA: se perderá al reiniciar y los recibos emitidos no podrán verificarse contra una clave futura.'
                    : health.seal.keyPersistence === 'env'
                      ? 'Clave inyectada por entorno.'
                      : 'Clave persistida junto al estado.'}
                </div>
              </div>
            )}
            {health.integrity && (
              <div className={`flex items-start gap-1.5 ${health.integrity.status === 'ok' ? 'text-emerald-300' : health.integrity.status === 'compromised' ? 'text-rose-300' : 'text-amber-300'}`}>
                <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  Integridad del estado: {health.integrity.status === 'ok' ? 'sin hallazgos' : health.integrity.status === 'compromised' ? 'COMPROMETIDA' : 'con avisos'}
                  {health.integrity.issues.length > 0 && ` — ${health.integrity.issues.slice(0, 3).join(' · ')}`}
                </span>
              </div>
            )}
            {health.destructiveOps && (
              <div className="text-slate-400">
                Operaciones destructivas (reset, demo, import):{' '}
                {health.destructiveOps.requiresToken
                  ? 'exigen token de administración.'
                  : health.destructiveOps.enabledByEnv
                    ? 'habilitadas por AQUA_ALLOW_DESTRUCTIVE.'
                    : health.destructiveOps.production
                      ? 'DESHABILITADAS en producción (define AQUA_ADMIN_TOKEN).'
                      : 'permitidas solo desde la propia máquina.'}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
