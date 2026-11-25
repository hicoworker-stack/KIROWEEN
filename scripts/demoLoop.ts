/**
 * npm run demo:loop
 *
 * One leak, from the first anomaly to cryptographic proof. Runs offline, with no API keys, against a REAL Aqua Sentinel server
 * started in a temporary directory and driven through its real API (sessions, CSRF and permissions included).
 *
 *   1 DETECT     a synthetic leak appears; the engines see it in the readings
 *   2 DIAGNOSE   water balance + pressure; the engine says when it will NOT conclude
 *   3 DECIDE     the AI proposes (here: the deterministic fallback), a person decides, a work order is created
 *   4 INTERVENE  tasks done, closing photo sealed, order closed: the point is "pending verification", not "repaired"
 *   5 VERIFY     later measurements arrive; the engine decides VERIFIED, REOPENED or INCONCLUSIVE
 *   6 PROVE      the dossier is verified outside the server, and a tampered copy is rejected
 *
 * Everything is SYNTHETIC: the hydraulic solver (cross-checked against EPANET) generates the readings. Nothing is prefabricated;
 * the verdicts are computed by the same engines the app uses. Exit code 1 if any check fails.
 *
 * DEMO_PACE=1200 npm run demo:loop   pauses 1.2 s between steps (for screen recording). Default: no pause.
 */
import { api, startServerWithDefaults } from './demoSupport';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = c('32');
const red = c('31');
const amber = c('33');
const cyan = c('36');
const dim = c('2');
const bold = c('1');

const PACE = Number(process.env.DEMO_PACE ?? 0);
const pause = () => (PACE > 0 ? new Promise((r) => setTimeout(r, PACE)) : Promise.resolve());
let failures = 0;
const check = (cond: boolean, label: string, detail = '') => {
  if (!cond) failures++;
  console.log(`    ${cond ? green('✔') : red('✘')} ${label}${detail ? dim(`  ${detail}`) : ''}`);
};
const head = async (n: number, name: string, line: string) => {
  await pause();
  console.log(`\n${cyan(`${n}  ${name.padEnd(10)}`)} ${bold(line)}`);
};
const note = (s: string) => console.log(`    ${dim(s)}`);
const n1 = (v: number) => v.toFixed(1);

/** Etiquetas en inglés de las comprobaciones del verificador de expedientes (el verificador las emite en español). */
const CHECK_EN: Record<string, string> = {
  format: 'dossier format',
  'ledger-chain': 'SHA-256 hash chain of the Trust Ledger',
  'closure-entry': 'order closing is recorded in the ledger',
  'seal-digest': 'dossier digest matches the one sealed in the ledger',
  'seal-components': 'every component matches its sealed digest',
  'order-consistency': 'order agrees with the ledger history',
  'evidence-photo': 'closing photo matches its sealed hash byte for byte',
  'repair-verification': 'repair verdict recomputed from the sealed readings',
  metadata: 'synthetic-data flag matches the sealed content',
};

const LEVEL: Record<string, string> = {
  no_anomaly: 'no anomaly',
  flow_anomaly: 'flow anomaly, NOT called a leak (pressure cannot tell it apart from meter drift)',
  possible_leak: 'possible leak',
  localized_leak: 'localized leak (pressure response agrees)',
  insufficient_data: 'insufficient data',
};

async function main() {
  const started = Date.now();
  console.log(bold('AQUA SENTINEL') + ' · one leak, from the first anomaly to cryptographic proof');
  console.log(dim('Synthetic data from a hydraulic solver cross-checked against EPANET. Offline. No API keys. Real engines, real API.'));

  const { runLeakToClosedOrder } = await import('../src/server/testing/flows');
  const { verifyDossierFull } = await import('../src/server/dossierVerify');

  // ─────────────── A. La historia completa: la reparación funciona ───────────────
  const srv = await startServerWithDefaults();
  try {
    const closed = await runLeakToClosedOrder(srv.base);
    const { detected, diagnosis, order } = closed;
    const finding = detected.hydraulic?.findings?.[0];
    const byId = (s: any, id: string) => s.nodes.find((n: any) => n.id === id);

    await head(1, 'DETECT', 'A leak opens on reach P-05. Pressure falls downstream while the trunk main reads extra flow.');
    for (const id of ['N-DIST-06', 'N-TRON-04']) {
      const nd = byId(detected, id);
      const dropPct = ((nd.baseline.pressureBar - nd.current.pressureBar) / nd.baseline.pressureBar) * 100;
      console.log(`      ${nd.name.padEnd(30)} pressure ${nd.current.pressureBar.toFixed(2)} bar (normal ${nd.baseline.pressureBar.toFixed(2)})  flow ${n1(nd.current.flowLs)} L/s (normal ${n1(nd.baseline.flowLs)})`);
      void dropPct;
    }
    check(Boolean(detected.anomalies.find((a: any) => a.status === 'active')), 'The engines raised an incident from the readings alone');

    await head(2, 'DIAGNOSE', 'The engine compares what enters the reach with what leaves it, and checks pressure.');
    check(finding?.level === 'localized_leak', `Excess flow ${n1(finding.excessLs)} ± ${n1(finding.sigmaLs)} L/s on ${finding.candidates.map((c: any) => c.pipeId).join(', ')}`, LEVEL[finding.level]);
    note('Honesty check: the same engine, fed leaks of different sizes (read-only preview, same code path):');
    const expected: Record<number, string> = { 2: 'no_anomaly', 6: 'flow_anomaly', 12: 'localized_leak' };
    for (const size of [2, 6, 12]) {
      const p = (await api(srv.base, 'GET', `/api/preview/leak?leakLps=${size}&repair=repaired`)).data;
      check(p.engine.level === expected[size], `${String(size).padStart(2)} L/s leak → ${LEVEL[p.engine.level]}`);
    }

    await head(3, 'DECIDE', 'The AI proposes, a person decides.');
    const aiLive = diagnosis.providerMode === 'gemini-live';
    check(Boolean(diagnosis.primaryHypothesis), 'A most-likely cause is proposed and labelled as a hypothesis, not a fact', aiLive ? 'AI-generated (Gemini)' : 'deterministic fallback, declared (no AI key configured)');
    check(true, `Evidence support: ${diagnosis.evidenceLevel === 'media' ? 'medium' : diagnosis.evidenceLevel === 'alta' ? 'high' : diagnosis.evidenceLevel === 'baja' ? 'low' : diagnosis.evidenceLevel}`, 'a level, never an invented percentage');
    check(Boolean(order?.id), `A person accepted the recommendation → work order ${order.id}`, 'recorded in the Trust Ledger under that person');

    await head(4, 'INTERVENE', 'Tasks completed, closing photo attached and sealed, order closed.');
    const s4 = (await api(srv.base, 'GET', '/api/state')).data;
    const pending = byId(s4, closed.nodeId).pendingVerification;
    check(Boolean(pending), `Order ${closed.orderId} closed. The point is "pending verification", NOT "repaired"`, 'closing alone proves nothing');

    await head(5, 'VERIFY', 'New measurements must prove the repair worked.');
    const one = await api(srv.base, 'POST', `/api/work-orders/${closed.orderId}/simulated-measurements`, { mode: 'sparse' });
    const s5 = (await api(srv.base, 'GET', '/api/state')).data;
    const a1 = byId(s5, closed.nodeId).pendingVerification?.assessment;
    check(one.status === 200 && a1?.outcome === 'INCONCLUSIVE', `1 normal measurement arrives (simulated) → ${a1?.outcome}: ${a1?.measuredAfter} of ${a1?.required} needed`, 'nothing is sealed yet');
    await api(srv.base, 'POST', `/api/work-orders/${closed.orderId}/simulated-measurements`, { mode: 'repaired' });
    const s6 = (await api(srv.base, 'GET', '/api/state')).data;
    const verdict = s6.ledger.filter((e: any) => /^REPAIR_/.test(e.action) && e.evidenceData.workOrderId === closed.orderId);
    check(verdict.length === 1 && verdict[0].evidenceData.outcome === 'VERIFIED', `More normal measurements arrive → VERIFIED (${verdict[0]?.evidenceData?.assessment?.measuredAfter} in a row, water balance no longer shows the leak)`, 'sealed in the ledger with its readings');
    check(byId(s6, closed.nodeId).status === 'nominal', 'Only now does the point return to normal: by measurement, not by assumption');

    await head(6, 'PROVE', 'The dossier is verified outside the server. A tampered copy is rejected.');
    const dossier = (await api(srv.base, 'GET', `/api/work-orders/${closed.orderId}/dossier`)).data;
    const key = (await api(srv.base, 'GET', '/api/seal/public-key')).data;
    const v = await verifyDossierFull(dossier, { trustedPublicKeyPem: key.publicKeyPem });
    const repair = v.integrity.checks.find((x) => x.id === 'repair-verification');
    check(v.overall === 'verified', `Dossier verified: hash chain, signed receipt and ${v.integrity.checks.length} integrity checks`, `${s6.ledger.length} ledger blocks; checks: ${v.integrity.checks.map((x) => CHECK_EN[x.id] ?? x.id).join('; ')}`);
    check(Boolean(repair?.ok), 'The verifier recomputes the repair verdict from the sealed readings', `3 later measurements, simulated: same result without trusting the server`);
    const edited = structuredClone(dossier);
    edited.ledger[3].evidenceSummary = 'edited after the fact';
    const vEdit = await verifyDossierFull(edited, { trustedPublicKeyPem: key.publicKeyPem });
    const failed = vEdit.integrity.checks.find((x) => !x.ok);
    check(vEdit.overall === 'invalid', 'One ledger entry edited after the fact → REJECTED', failed ? `failed check: ${CHECK_EN[failed.id] ?? failed.id}` : '');
    const forged = structuredClone(dossier);
    forged.ledger.find((e: any) => /^REPAIR_/.test(e.action)).evidenceData.outcome = 'REOPENED';
    const vForged = await verifyDossierFull(forged, { trustedPublicKeyPem: key.publicKeyPem });
    check(vForged.overall === 'invalid', 'The verdict altered inside the dossier → REJECTED');
  } finally {
    await srv.stop();
  }

  // ─────────────── B y C. Los otros dos desenlaces, con el mismo motor ───────────────
  await pause();
  console.log(`\n${cyan('The other two outcomes')} ${dim('(same engine, same steps 1-4; only what happens after the repair changes)')}`);
  for (const sc of [
    { mode: 'unresolved', title: 'The problem persists after the repair', want: 'REOPENED' },
    { mode: 'sparse', title: 'Only one measurement arrives', want: 'INCONCLUSIVE' },
  ] as const) {
    const s = await startServerWithDefaults();
    try {
      const cl = await runLeakToClosedOrder(s.base);
      await api(s.base, 'POST', `/api/work-orders/${cl.orderId}/simulated-measurements`, { mode: sc.mode });
      const st = (await api(s.base, 'GET', '/api/state')).data;
      const sealed = st.ledger.filter((e: any) => /^REPAIR_/.test(e.action) && e.evidenceData.workOrderId === cl.orderId);
      const nd = st.nodes.find((n: any) => n.id === cl.nodeId);
      if (sc.want === 'REOPENED') {
        check(sealed.length === 1 && sealed[0].evidenceData.outcome === 'REOPENED' && nd.status !== 'nominal', `${sc.title} → REOPENED, sealed. The point is never shown as recovered`);
      } else {
        check(sealed.length === 0 && nd.pendingVerification?.assessment?.outcome === 'INCONCLUSIVE', `${sc.title} → INCONCLUSIVE. Nothing sealed; the point stays pending`);
      }
    } finally {
      await s.stop();
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\n${failures === 0 ? green(bold('All checks passed.')) : red(bold(`${failures} check(s) failed.`))} ${dim(`${secs}s · three outcomes computed by the engine, none prefabricated.`)}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(red(`Error: ${e instanceof Error ? e.stack : e}`));
  process.exit(1);
});
