import React, { useEffect, useRef } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Clock3, Info, Loader2, OctagonAlert, WifiOff, X } from 'lucide-react';
import { HealthKey, PROVENANCE_META, Provenance, Tone } from '../ui/vocab';

/**
 * Primitivos del sistema visual. Todo el estado se comunica con color + icono + palabra (nunca solo con color),
 * y todo control interactivo mide al menos 44 px de alto para el uso táctil en campo.
 */

export const TONE: Record<Tone, { text: string; bg: string; border: string; dot: string }> = {
  ok: { text: 'text-ok', bg: 'bg-ok/10', border: 'border-ok/40', dot: 'bg-ok' },
  attention: { text: 'text-attention', bg: 'bg-attention/10', border: 'border-attention/40', dot: 'bg-attention' },
  critical: { text: 'text-critical', bg: 'bg-critical/10', border: 'border-critical/50', dot: 'bg-critical' },
  verifying: { text: 'text-verifying', bg: 'bg-verifying/10', border: 'border-verifying/40', dot: 'bg-verifying' },
  offline: { text: 'text-offline', bg: 'bg-offline/10', border: 'border-offline/40', dot: 'bg-offline' },
  neutral: { text: 'text-soft', bg: 'bg-raised', border: 'border-line', dot: 'bg-quiet' },
};

export const toneIcon = (tone: Tone): React.FC<{ className?: string }> =>
  tone === 'ok' ? CheckCircle2 : tone === 'critical' ? OctagonAlert : tone === 'verifying' ? Clock3 : tone === 'offline' ? WifiOff : AlertTriangle;

export const HEALTH_TONE: Record<HealthKey, Tone> = { stable: 'ok', attention: 'attention', critical: 'critical', verifying: 'verifying', offline: 'offline' };

export const StatusPill: React.FC<{ tone: Tone; label: string; title?: string; className?: string }> = ({ tone, label, title, className = '' }) => {
  const Icon = toneIcon(tone);
  const c = TONE[tone];
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${c.bg} ${c.border} ${c.text} ${className}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {label}
    </span>
  );
};

const PROVENANCE_STYLE: Record<Provenance, string> = {
  medido: 'border-ok/50 text-ok',
  declarado: 'border-attention/60 text-attention',
  inferido: 'border-accent/50 text-accent',
  hipotesis_ia: 'border-verifying/60 text-verifying',
  simulado: 'border-offline/70 text-offline border-dashed',
};

/** Etiqueta de procedencia: de dónde sale un dato. Se explica al pasar el cursor y para lectores de pantalla. */
export const ProvenanceBadge: React.FC<{ kind: Provenance; className?: string }> = ({ kind, className = '' }) => (
  <span
    title={PROVENANCE_META[kind].help}
    aria-label={`${PROVENANCE_META[kind].label}: ${PROVENANCE_META[kind].help}`}
    className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-bold tracking-wide whitespace-nowrap ${PROVENANCE_STYLE[kind]} ${className}`}
  >
    {PROVENANCE_META[kind].label}
  </span>
);

export const ProvenanceRow: React.FC<{ kinds: Provenance[] }> = ({ kinds }) =>
  kinds.length === 0 ? null : (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {kinds.map((k) => (
        <ProvenanceBadge key={k} kind={k} />
      ))}
    </span>
  );

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
const BUTTON_STYLE: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-[#041018] hover:bg-cyan-300 font-semibold',
  secondary: 'bg-raised text-ink border border-line-strong hover:bg-[#143349] font-medium',
  danger: 'bg-transparent text-critical border border-critical/50 hover:bg-critical/10 font-medium',
  ghost: 'bg-transparent text-soft hover:text-ink hover:bg-raised font-medium',
};

export const Button: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; busy?: boolean; block?: boolean; icon?: React.ReactNode }
> = ({ variant = 'secondary', busy = false, block = false, icon, children, className = '', disabled, ...rest }) => (
  <button
    type="button"
    {...rest}
    disabled={disabled || busy}
    aria-busy={busy || undefined}
    className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer ${block ? 'w-full' : ''} ${BUTTON_STYLE[variant]} ${className}`}
  >
    {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : icon}
    {children}
  </button>
);

export const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => <div aria-hidden="true" className={`animate-pulse rounded-md bg-raised ${className}`} />;

export const Notice: React.FC<{ tone?: Tone; title?: string; children: React.ReactNode; onClose?: () => void; live?: 'polite' | 'assertive' | 'off' }> = ({ tone = 'neutral', title, children, onClose, live = 'polite' }) => {
  const c = TONE[tone];
  const Icon = tone === 'neutral' ? Info : toneIcon(tone);
  return (
    <div role={live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : undefined} className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${c.bg} ${c.border}`}>
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${c.text}`} aria-hidden="true" />
      <div className="min-w-0 flex-1 text-ink">
        {title && <p className={`font-semibold ${c.text}`}>{title}</p>}
        <div className="text-soft [&_strong]:text-ink">{children}</div>
      </div>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Cerrar aviso" className="-m-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-quiet hover:text-ink">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
};

export const EmptyState: React.FC<{ icon: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }> = ({ icon, title, children, action }) => (
  <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
    <div className="text-quiet">{icon}</div>
    <h2 className="text-lg font-semibold text-ink">{title}</h2>
    {children && <p className="max-w-md text-sm leading-relaxed text-soft">{children}</p>}
    {action}
  </div>
);

/** Detalles opcionales: la información técnica queda a un clic, nunca en la cara del usuario cotidiano. */
export const Disclosure: React.FC<{ summary: string; children: React.ReactNode; defaultOpen?: boolean }> = ({ summary, children, defaultOpen }) => (
  <details open={defaultOpen} className="group rounded-lg border border-line">
    <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 text-sm font-medium text-soft hover:text-ink">
      {summary}
      <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
    </summary>
    <div className="space-y-4 border-t border-line px-4 py-4">{children}</div>
  </details>
);

/** Cada bloque responde una de las tres preguntas: qué pasa, qué significa, qué hacer. */
export const Question: React.FC<{ q: string; children: React.ReactNode; id?: string }> = ({ q, children, id }) => (
  <section aria-labelledby={id} className="space-y-2">
    <h3 id={id} className="text-xs font-bold uppercase tracking-wider text-quiet">
      {q}
    </h3>
    {children}
  </section>
);

export const ConfirmDialog: React.FC<{
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ open, title, children, confirmLabel, tone = 'primary', busy, onConfirm, onCancel }) => {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close?.();
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="m-auto w-[min(92vw,26rem)] rounded-xl border border-line-strong bg-surface p-0 text-ink backdrop:bg-black/60"
    >
      <div className="space-y-4 p-5">
        <h2 id="confirm-title" className="text-lg font-semibold">
          {title}
        </h2>
        <div className="text-sm leading-relaxed text-soft">{children}</div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancelar
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} busy={busy} autoFocus>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
};

export const MetricRow: React.FC<{ label: string; value: string; context: string; provenance?: Provenance[]; tone?: Tone }> = ({ label, value, context, provenance = [], tone = 'neutral' }) => (
  <div className="flex items-baseline justify-between gap-4 border-b border-line/70 py-3 last:border-b-0">
    <div className="min-w-0">
      <p className="text-sm text-soft">{label}</p>
      <p className="text-xs text-quiet">{context}</p>
    </div>
    <div className="shrink-0 text-right">
      <p className={`font-display text-lg font-semibold tabular-nums ${tone === 'neutral' ? 'text-ink' : TONE[tone].text}`}>{value}</p>
      {provenance.length > 0 && <ProvenanceRow kinds={provenance} />}
    </div>
  </div>
);
