import { apiFetch } from '../client/api';
import React, { useState } from 'react';
import { ShieldCheck, ShieldAlert, Lock, AlertTriangle, RotateCcw } from 'lucide-react';
import { verifyLedgerChain } from '../core/cryptoLedger';
import { ChainVerificationResult, TrustLedgerEntry } from '../core/types';

interface TrustLedgerViewProps {
  ledger: TrustLedgerEntry[];
}

export const TrustLedgerView: React.FC<TrustLedgerViewProps> = ({ ledger }) => {
  const [clientVerification, setClientVerification] = useState<ChainVerificationResult | null>(null);
  const [serverVerification, setServerVerification] = useState<ChainVerificationResult | null>(null);
  const [serverVerifyError, setServerVerifyError] = useState<string | null>(null);
  const [tamperedPreview, setTamperedPreview] = useState<TrustLedgerEntry[] | null>(null);
  const [verifying, setVerifying] = useState(false);

  const displayedChain = tamperedPreview ?? ledger;
  const verification = clientVerification;

  const handleVerify = async (chainToTest: TrustLedgerEntry[] = displayedChain) => {
    setVerifying(true);
    setServerVerifyError(null);
    try {
      const [clientSettled, serverSettled] = await Promise.allSettled([
        verifyLedgerChain(chainToTest),
        apiFetch('/api/ledger/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ledger: chainToTest }),
        }).then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return (await res.json()) as ChainVerificationResult;
        }),
      ]);

      if (clientSettled.status === 'fulfilled') {
        setClientVerification(clientSettled.value);
      }

      if (serverSettled.status === 'fulfilled') {
        setServerVerification(serverSettled.value);
      } else {
        setServerVerification(null);
        setServerVerifyError(
          serverSettled.reason instanceof Error
            ? serverSettled.reason.message
            : 'No se pudo consultar /api/ledger/verify'
        );
      }
    } finally {
      setVerifying(false);
    }
  };

  const handleSimulateTamper = async () => {
    if (ledger.length === 0) return;
    const targetIdx = ledger.length > 1 ? 1 : 0;
    const mutated = ledger.map((entry, idx) =>
      idx === targetIdx
        ? {
            ...entry,
            evidenceSummary: '[ALTERACIÓN SIMULADA] Evidencia manipulada sin recalcular SHA-256',
          }
        : entry
    );
    setTamperedPreview(mutated);
    await handleVerify(mutated);
  };

  const handleRestoreValidChain = async () => {
    setTamperedPreview(null);
    await handleVerify(ledger);
  };

  const hasDiscrepancy =
    clientVerification !== null &&
    serverVerification !== null &&
    (clientVerification.valid !== serverVerification.valid ||
      clientVerification.brokenIndex !== serverVerification.brokenIndex);

  const overallValid =
    clientVerification !== null &&
    clientVerification.valid &&
    (serverVerification === null ? false : serverVerification.valid) &&
    !hasDiscrepancy;

  return (
    <div className="space-y-6">
      <section className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-cyan-400" />
            <h2 className="text-lg font-semibold text-white">
              Trust Ledger — Registro Criptográfico Encadenado (SHA-256)
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Auditoría append-only con verificación dual (Web Crypto en cliente +{' '}
            <code className="font-mono text-cyan-300">/api/ledger/verify</code> en servidor).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {!tamperedPreview ? (
            <button
              type="button"
              onClick={handleSimulateTamper}
              disabled={ledger.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#06131C] hover:bg-[#0F2736] text-amber-300 border border-amber-500/30 rounded-lg cursor-pointer whitespace-nowrap shrink-0"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              Simular Alteración (Prueba Auditoría)
            </button>
          ) : (
            <button
              type="button"
              onClick={handleRestoreValidChain}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#06131C] hover:bg-[#0F2736] text-cyan-300 border border-cyan-500/40 rounded-lg cursor-pointer whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Restaurar Cadena Íntegra
            </button>
          )}

          <button
            type="button"
            disabled={verifying}
            onClick={() => handleVerify(displayedChain)}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-[#041018] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            {verifying ? 'Verificando...' : 'Verificar Integridad de Cadena'}
          </button>
        </div>
      </section>

      {clientVerification && (
        <section
          className={`p-4 rounded-xl border space-y-3 ${
            hasDiscrepancy
              ? 'bg-[#2A1B08] border-amber-500/60 text-amber-200'
              : overallValid
                ? 'bg-[#07211D] border-emerald-500/40 text-emerald-200'
                : 'bg-[#2A0B14] border-rose-500/50 text-rose-200'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              {overallValid ? (
                <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
              ) : (
                <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              )}
              <div className="text-xs space-y-1">
                <div className="font-semibold text-sm">
                  {hasDiscrepancy
                    ? 'Discrepancia detectada entre verificación cliente y servidor'
                    : overallValid
                      ? `Cadena Verificada Dual: ${clientVerification.checkedCount}/${displayedChain.length} bloques íntegros`
                      : clientVerification.valid && serverVerifyError
                        ? `Cliente íntegro (${clientVerification.checkedCount}/${displayedChain.length}), servidor no verificado`
                        : `Integridad Rota en Bloque #${
                            clientVerification.brokenIndex ?? serverVerification?.brokenIndex
                          }`}
                </div>
                <p className="text-slate-300">
                  {hasDiscrepancy
                    ? `Cliente (${clientVerification.valid ? 'válido' : `roto #${clientVerification.brokenIndex}`}) vs Servidor (${serverVerification?.valid ? 'válido' : `roto #${serverVerification?.brokenIndex}`}).`
                    : overallValid
                      ? 'Todos los digests SHA-256 y enlaces previousHash coinciden matemáticamente en Cliente Web Crypto y Servidor.'
                      : clientVerification.reason ?? serverVerification?.reason ?? serverVerifyError}
                </p>
              </div>
            </div>
            <span className="text-xs font-mono text-slate-300">
              Verificado: {new Date(clientVerification.verifiedAt).toLocaleTimeString('es-ES')}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-2 border-t border-white/10 text-xs">
            <div className="p-2.5 rounded-lg bg-[#06131C]/80 border border-[#18364A] flex items-center justify-between gap-2">
              <span className="font-mono text-slate-300">Cliente (Web Crypto SHA-256)</span>
              <span
                className={`font-mono font-semibold ${
                  clientVerification.valid ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {clientVerification.valid
                  ? `✓ ${clientVerification.checkedCount}/${displayedChain.length} íntegros`
                  : `✖ Roto #${clientVerification.brokenIndex}`}
              </span>
            </div>
            <div className="p-2.5 rounded-lg bg-[#06131C]/80 border border-[#18364A] flex items-center justify-between gap-2">
              <span className="font-mono text-slate-300">Servidor (POST /api/ledger/verify)</span>
              {serverVerification ? (
                <span
                  className={`font-mono font-semibold ${
                    serverVerification.valid ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {serverVerification.valid
                    ? `✓ ${serverVerification.checkedCount}/${displayedChain.length} íntegros`
                    : `✖ Roto #${serverVerification.brokenIndex}`}
                </span>
              ) : (
                <span className="font-mono text-amber-300">
                  ⚠ {serverVerifyError ?? 'Sin respuesta'}
                </span>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Hash Chain Table */}
      <section className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>Bloques encadenados: {displayedChain.length}</span>
          <span className="font-mono">Algoritmo: Web Crypto + Node SHA-256</span>
        </div>

        <div className="space-y-3">
          {[...displayedChain].reverse().map((entry) => {
            const isBroken =
              verification && !verification.valid && verification.brokenIndex === entry.index;

            return (
              <div
                key={entry.id}
                className={`p-4 rounded-lg border space-y-2.5 ${
                  isBroken
                    ? 'bg-[#2A0B14] border-rose-500'
                    : 'bg-[#06131C] border-[#18364A]'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2 font-mono">
                    <span className="text-cyan-400 font-semibold">
                      #{entry.index} · {entry.id}
                    </span>
                    <span aria-hidden="true" className="text-[#234C66]">·</span>
                    <span className="text-white font-semibold">{entry.action}</span>
                    <span aria-hidden="true" className="text-[#234C66]">·</span>
                    <span className="text-slate-400">{entry.assetId}</span>
                  </div>
                  <span className="font-mono text-slate-400 tabular-nums">
                    {new Date(entry.timestamp).toLocaleString('es-ES')}
                  </span>
                </div>

                <p className="text-xs text-slate-200 leading-relaxed">{entry.evidenceSummary}</p>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                  <span>Actor: <span className="text-slate-200">{entry.actor}</span></span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Transición: <span className="font-mono text-amber-300">{entry.previousState}</span> →{' '}
                    <span className="font-mono text-emerald-300">{entry.newState}</span>
                  </span>
                </div>

                <div className="pt-2 border-t border-[#122B3B] grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px] font-mono text-slate-400">
                  <div className="truncate">
                    <span className="text-slate-500">prevHash: </span>
                    {entry.previousHash}
                  </div>
                  <div className="truncate text-cyan-300/90">
                    <span className="text-slate-500">sha256: </span>
                    {entry.hash}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};
