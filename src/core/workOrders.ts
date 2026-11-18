import { ChecklistItem, ClosureEvidence, SmartWorkOrder } from './types';

/** REQ-WO-02: lógica pura de órdenes de trabajo (checklist, responsable, bloqueos de cierre). */

export const MAX_ASSIGNEE_LENGTH = 80;
export const MAX_EVIDENCE_BYTES = 6 * 1024 * 1024;
export const ALLOWED_EVIDENCE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;

export function buildChecklist(steps: string[]): ChecklistItem[] {
  return steps
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((label, i) => ({ id: `CK-${i + 1}`, label, done: false }));
}

/** Órdenes persistidas antes de M-10 no tienen checklist: se deriva de interventionSteps. */
export function ensureChecklist(order: SmartWorkOrder): SmartWorkOrder {
  if (Array.isArray(order.checklist)) return order;
  return { ...order, checklist: buildChecklist(order.interventionSteps) };
}

export class WorkOrderError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export function normalizeAssignee(raw: unknown): string {
  if (typeof raw !== 'string') throw new WorkOrderError('El responsable debe ser texto.', 400);
  const value = raw.replace(/\s+/g, ' ').trim();
  if (value.length < 2) throw new WorkOrderError('El responsable debe tener al menos 2 caracteres.', 400);
  if (value.length > MAX_ASSIGNEE_LENGTH) {
    throw new WorkOrderError(`El responsable no puede superar ${MAX_ASSIGNEE_LENGTH} caracteres.`, 400);
  }
  return value;
}

export function setChecklistItem(
  order: SmartWorkOrder,
  itemId: string,
  done: boolean,
  actor: string,
  now: string
): { order: SmartWorkOrder; item: ChecklistItem } {
  if (order.status === 'Cerrada') {
    throw new WorkOrderError('La orden está cerrada; el checklist ya no es editable.', 409);
  }
  const base = ensureChecklist(order);
  const idx = base.checklist!.findIndex((c) => c.id === itemId);
  if (idx === -1) throw new WorkOrderError('Ítem de checklist no encontrado.', 404);
  const item: ChecklistItem = done
    ? { ...base.checklist![idx], done: true, doneAt: now, doneBy: actor }
    : { id: base.checklist![idx].id, label: base.checklist![idx].label, done: false };
  const checklist = base.checklist!.map((c, i) => (i === idx ? item : c));
  return { order: { ...base, checklist, updatedAt: now }, item };
}

export function closureBlockers(order: SmartWorkOrder): string[] {
  const blockers: string[] = [];
  const pending = (ensureChecklist(order).checklist ?? []).filter((c) => !c.done);
  if (pending.length > 0) {
    blockers.push(`Checklist incompleto: faltan ${pending.length} paso(s) (${pending.map((p) => p.id).join(', ')}).`);
  }
  if (!order.closureEvidence) {
    blockers.push('Falta evidencia fotográfica de cierre.');
  }
  return blockers;
}

export interface ParsedEvidence {
  mimeType: (typeof ALLOWED_EVIDENCE_MIME)[number];
  base64: string;
  sizeBytes: number;
}

/** Valida un data URL de imagen sin confiar en el nombre de archivo del cliente. */
export function parseEvidenceDataUrl(dataUrl: unknown): ParsedEvidence {
  if (typeof dataUrl !== 'string') throw new WorkOrderError('La evidencia debe ser un data URL de imagen.', 400);
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) throw new WorkOrderError('Formato de evidencia inválido (se requiere imagen base64).', 400);
  const mimeType = match[1].toLowerCase();
  if (!(ALLOWED_EVIDENCE_MIME as readonly string[]).includes(mimeType)) {
    throw new WorkOrderError('Tipo de imagen no permitido (usa JPEG, PNG o WebP).', 415);
  }
  const base64 = match[2].replace(/\s/g, '');
  const sizeBytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  if (sizeBytes <= 0) throw new WorkOrderError('La imagen está vacía.', 400);
  if (sizeBytes > MAX_EVIDENCE_BYTES) {
    throw new WorkOrderError(`La imagen supera el máximo de ${MAX_EVIDENCE_BYTES / 1024 / 1024} MB.`, 413);
  }
  return { mimeType: mimeType as ParsedEvidence['mimeType'], base64, sizeBytes };
}

export function sanitizeFileName(name: unknown): string {
  const raw = typeof name === 'string' ? name : 'evidencia';
  const base = raw.split(/[\\/]/).pop() ?? 'evidencia';
  const clean = base.replace(/[^\w.\- ]+/g, '_').trim().slice(0, 80);
  return clean || 'evidencia';
}

export function attachEvidence(
  order: SmartWorkOrder,
  evidence: ClosureEvidence,
  now: string
): SmartWorkOrder {
  if (order.status === 'Cerrada') {
    throw new WorkOrderError('La orden está cerrada; no se puede reemplazar la evidencia.', 409);
  }
  return { ...order, closureEvidence: evidence, closureEvidenceLabel: `${evidence.fileName} · sha256:${evidence.sha256.slice(0, 12)}…`, updatedAt: now };
}

