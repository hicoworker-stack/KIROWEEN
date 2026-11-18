import React, { useCallback, useEffect, useState } from 'react';
import { Database, Download, Upload, Zap } from 'lucide-react';

interface Health {
  aiProvider: string;
  aiMode: 'gemini-live' | 'fallback-adapter';
  geminiModel: string;
  geminiHealth: { lastSuccessAt: string | null; lastErrorAt: string | null; lastError: string | null; verified: boolean };
  persistence: { kind: string; statePath: string; writable: boolean; ephemeralRisk: 'alto' | 'medio' | 'bajo'; note: string };
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
      setMessage({ kind: 'ok', text: 'Snapshot exportado con fotos de cierre incluidas.' });
    } catch (e) {
      setMessage({ kind: 'error', text: `No se pudo exportar: ${e instanceof Error ? e.message : 'error'}` });
    }
  };

  const importSnapshot = async (file: File) => {
    setMessage(null);
    try {
      const body = JSON.parse(await file.text());
      const res = await fetch('/api/state/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ kind: 'error', text: `Snapshot rechazado: ${(data.errors ?? [data.error]).join(' · ')}` });
        return;
      }
      setMessage({ kind: 'ok', text: 'Snapshot verificado y restaurado. La cadena del ledger fue validada antes de aceptarlo.' });
      onStateChanged();
      await load();
    } catch {
      setMessage({ kind: 'error', text: 'El archivo no es un snapshot JSON válido.' });
    }
  };

  const riskClass =
    health?.persistence.ephemeralRisk === 'alto'
      ? 'text-rose-300'
      : health?.persistence.ephemeralRisk === 'medio'
        ? 'text-amber-300'
        : 'text-emerald-300';

  return (
    <section className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 space-y-4" aria-labelledby="ops-health-title">
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4 text-cyan-400" />
        <h3 id="ops-health-title" className="text-base font-semibold text-white">Estado real de IA y persistencia</h3>
      </div>

      {loadError && (
        <p role="alert" className="text-xs text-rose-300">No se pudo leer /api/health: {loadError}</p>
      )}
      {!health && !loadError && <p className="text-xs text-slate-400">Cargando estado del servidor…</p>}

      {health && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
          <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2">
            <div className="text-slate-400">Gemini</div>
            <div className="font-semibold text-cyan-300">{health.aiProvider}</div>
            <div className="text-slate-400 font-mono">Modelo: {health.geminiModel}</div>
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
                    ? 'Sin GEMINI_API_KEY: el sistema opera con el adaptador determinista.'
                    : `Falló la llamada a ${probe.model}: ${probe.error}`}
              </p>
            )}
          </div>

          <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2">
            <div className="text-slate-400">Persistencia</div>
            <div className="font-semibold text-slate-100">Archivo local del servidor ({health.persistence.writable ? 'escritura OK' : 'SIN permiso de escritura'})</div>
            <div className="text-slate-400 font-mono break-all">{health.persistence.statePath}</div>
            <div className={`${riskClass}`}>Riesgo de pérdida por entorno efímero: {health.persistence.ephemeralRisk}. {health.persistence.note}</div>
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
        </div>
      )}
    </section>
  );
};
