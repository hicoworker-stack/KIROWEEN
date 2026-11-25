# Aqua Sentinel: 3-minute demo script and storyboard

Status: **not recorded yet.** This file is the script to record from. No video is published, and none should be claimed until it is uploaded to YouTube and linked in the Devpost form.

The story in one line: **a hydraulic anomaly → a grounded diagnosis → an intervention → new measurements → a verified repair → a cryptographically checkable dossier.**

The three things the jury must remember:
1. The diagnosis says when it cannot conclude.
2. A repair counts only after later measurements confirm it.
3. The evidence can be checked by a third party, and tampering is rejected.

Target length 2:50. The Devpost rules say judges need not watch past 3:00, so nothing essential sits after 2:45.

## Before recording

- Run the app in English: `npm run dev -- --open`, then open `http://127.0.0.1:3000/?lang=en`. On a deployed instance, log in with the judge account (role OPERATOR).
- Use a fresh state: Advanced tools → Demonstration → "Back to the normal state" (needs the administrator password), or restart the server.
- Window 1440×900, browser zoom 100%, hide bookmarks and notifications. Record the screen at 1080p, voice-over recorded separately or live.
- Have a terminal ready with `npm run demo:loop` (it finishes in about 7 seconds). `DEMO_PACE=1200` slows it for recording.
- No third-party music or logos (Devpost rule). Everything on screen is synthetic and labelled SIMULATED.

## Storyboard

| Time | Screen | Presenter action | What the jury sees | Narration (English) |
| --- | --- | --- | --- | --- |
| 0:00–0:12 | Home, hero | None. Let the hero play. | Product name, the EN/ES switch, the five-step line. | "Water systems lose water to leaks nobody sees, and a repair counts as done when the crew drives away. Aqua Sentinel does not accept that." |
| 0:12–0:50 | Home, 3D model, step "Anomaly" | Scroll to the model. Click step 2. Drag **Simulated leak size** to 2, then 6, then 12 L/s. | The engine panel changes: no anomaly at 2 L/s; "flow anomaly" at 6 L/s, not called a leak; localized leak on P-05 at 12 L/s with the balance numbers. | "This is a synthetic network. A joint on pipe P-05 starts to leak. At 2 liters per second the engine sees nothing. At 6 it sees a flow anomaly, and it refuses to call it a leak, because pressure cannot confirm it. At 12, pressure agrees and it localizes the leak to one pipe. These numbers come from the real engine, not from the animation." |
| 0:50–1:12 | Advanced tools → Demonstration, then Incidents | Click "1. Trunk-main leak". Open the incident. Scroll the evidence, then the hypotheses. | What is happening, the evidence channels, the competing hypotheses, what is missing, and the stated uncertainty. | "The AI proposes, a person decides. Here is the evidence, the alternatives it could not rule out, and what is still unknown." |
| 1:12–1:20 | Incident | Click **Accept and create the work order**. | The order appears in Work orders. | "I accept the recommendation. That decision is recorded." |
| 1:20–1:42 | Work orders | Click **Start the intervention**. Tick each task. Add the closing photo. Click **Close the order**. | The order closes, but the point shows "pending verification", not "recovered". | "Closing the order proves nothing. The point stays pending verification." |
| 1:42–2:08 | Work orders, verification panel | Click **Simulate the measurements that would arrive afterwards**, then **Only one measurement arrives**. Then, on the same order, **The repair worked**. | First "inconclusive", nothing sealed. Then "Repair verified", with three consecutive normal measurements and a SIMULATED badge. | "One normal reading is not enough: inconclusive. After three consecutive normal measurements, and with the water balance no longer showing the leak, the repair is verified. If the problem persisted, the case would reopen. A repair is never shown as recovered without measurements." |
| 2:08–2:32 | Terminal, `npm run demo:loop` | Switch to the terminal and run it. | Six steps, three outcomes (VERIFIED, REOPENED, INCONCLUSIVE), then two REJECTED lines. | "The same engines run end to end, offline, with no API keys. Verified, reopened, inconclusive." |
| 2:32–2:50 | Work orders → **Download the verifiable dossier**, then Advanced tools → Trust Ledger → **Simulate tampering (audit test)** | Download the dossier. Open the ledger. Click the tamper button, then **Verify chain integrity**. | The chain turns red at the altered block. | "The verdict travels with its evidence, and a verifier recomputes it without trusting the server. Change one entry, or the verdict, and it is rejected." |
| 2:50–3:00 | README, "How Kiro was used" | Show the README section briefly. | 89 requirements, each tied to a test. | "Built with Kiro specs, hooks and property-based tests. The AI proposes, the physics checks, and the evidence proves." |

Word count of the narration is about 300, which fits at a calm pace.

## Where this matches the product (checked 2026-11-25)

| Script step | Where in the code | Test that covers it |
| --- | --- | --- |
| 3D slider levels (2 → no anomaly, 6 → flow anomaly, 12 → localized leak) | `src/server/leakPreview.ts` | `src/server/leakPreview.test.ts` |
| Accept, tasks, photo, close, pending verification | `src/components/IncidentsView.tsx`, `WorkOrdersView.tsx` | `src/server/repairLoop.test.ts` |
| Sparse then repaired on the same order | `POST /api/work-orders/:id/simulated-measurements` | `src/server/repairLoop.test.ts`, and a manual run on 2026-11-25 (INCONCLUSIVE with 1 reading, then VERIFIED) |
| Dossier download and offline verification | `src/core/dossier.ts` | `src/server/dossier.test.ts` |
| Tamper detection | `src/core/cryptoLedger.ts` | `src/core/cryptoLedger.test.ts`, `scripts/demoLoop.ts` |

## Takes and fallbacks

- If the live click-through fails in a take, record the two parts separately: the app up to "pending verification", then the terminal.
- A sparse-then-repaired sequence needs one closed order. If an order was already verified, trigger the leak again from the Demonstration tab.
- The REOPENED outcome is shown in the terminal and in the 3D step 5 selector ("The problem persists"), so the live part never needs a second order.

## Upload checklist (not done)

- [ ] Recorded, under 3:00, English narration or English subtitles
- [ ] Uploaded to YouTube as public
- [ ] Link pasted in the Devpost form
- [ ] The video shows the project running, not slides
