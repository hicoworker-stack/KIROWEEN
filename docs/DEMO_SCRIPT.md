# Aqua Sentinel: 3-minute demo script and storyboard

Status: **not recorded yet.** This is the recording package. No video is published, and none should be claimed until it is on YouTube (public) and linked in the Devpost form.

**The story:** a hydraulic anomaly → a diagnosis that knows its limits → an intervention → new measurements → a verified repair → an evidence record anyone can check.

**What the jury must remember:**
1. The diagnosis says when it cannot conclude.
2. A repair counts only after later measurements confirm it.
3. The evidence can be checked, and tampering is caught.

Target length **2:45**. Judges are not required to watch past 3:00 (Devpost rules), so the closing line starts at 2:36 and nothing essential comes later.

Every step below was executed click by click in a real browser on 2026-11-25, in English, at 1440×900 and at 390×844, with the guest session the presenter will use: 26 of 26 checks passed, with no console or HTTP errors. The screenshots in [`storyboard/`](storyboard/) come from that run.

## Before recording

1. Start a clean instance without touching your normal data:
   ```powershell
   $env:AQUA_STATE_PATH = "data/recording-state.json"; npm run dev -- --open
   ```
   Delete `data/recording-state.json` between takes to start from zero again.
2. Open `http://127.0.0.1:3000/?lang=en`. The header shows **EN** selected and the **SIMULATED** badge.
3. Browser window 1440×900, zoom 100%, no bookmarks bar, notifications off.
4. Keep a JPG on the desktop for the closing photo (any photo; for example `public/images/video-poster-en.jpg`).
5. Recording tools on this machine: Snipping Tool (screen recording), Xbox Game Bar (`Win+Alt+R`), and Clipchamp to add the voice-over and export 1080p. No third-party music or logos.
6. Rehearse once: the order steps (tasks, photo, close) take about 25 seconds with practice.

## Storyboard

Narration is 296 words, about 1.8 words per second overall and at most 2.4 in any scene, which leaves room for pauses. Times are cumulative.

### 1 · Problem (0:00–0:13)
- **Screen:** Home, hero. ([01-home.png](storyboard/01-home.png))
- **Action:** none.
- **Jury sees:** the product name and the SIMULATED badge.
- **Say:** "Water networks lose water through leaks that are hard to see. And in a report-and-close workflow, a repair counts as done when the ticket closes, with no data showing it worked."

### 2 · Diagnosis that knows its limits (0:13–0:50)
- **Screen:** Home, scroll to the 3D model. Click **Next step** twice to reach **STEP 3 OF 5 · INVESTIGATION**.
- **Action:** drag **Simulated leak size** to 2, then 6, then 12 L/s. Pause on each.
- **Jury sees:** the panel "What the hydraulic engine concludes" changes: *no anomaly* at 2 L/s; *flow anomaly (not corroborated)* at 6 L/s ([02](storyboard/02-3d-flow-anomaly-6Ls.png)); *Leak localized to a reach* at 12 L/s, with inflow, outflow, excess ± uncertainty and detection limit ([03](storyboard/03-3d-localized-leak-12Ls.png)).
- **Say:** "This is a synthetic network, and a joint on pipe P-05 starts to leak. At 2 liters per second the engine sees nothing: that is below what the meters can detect. At 6 it sees a flow anomaly, and it refuses to call it a leak, because pressure cannot confirm it. At 12, pressure agrees, and it localizes the leak to one pipe, with its uncertainty. These numbers come from the real engine, not from the animation."

### 3 · Decision (0:50–1:15)
- **Screen:** **Menu → Advanced tools → Demonstration**, click **1. Trunk-main leak**. Then **Menu → Incidents** and open the incident.
- **Action:** scroll through **Evidence**, then click **Accept and create the work order**.
- **Jury sees:** the evidence channels with their provenance (MEASURED, INFERRED, SIMULATED), a photo marked as *not analyzed, not used as evidence*, the alternatives and what is missing ([04](storyboard/04-incident-evidence.png)).
- **Say:** "The same leak, now as an incident. The system shows what supports it, what it could not rule out, and that an unanalyzed photo does not count as evidence. A person decides. I accept, and a work order is created. The ledger records who made the decision."

### 4 · Intervention (1:15–1:42)
- **Screen:** **Menu → Work orders**, select the order.
- **Action:** **Start the intervention** → tick the four tasks → **Take or add the photo** (choose the JPG) → **Close the order** → **Yes, close the order**.
- **Jury sees:** after closing, **Was the infrastructure restored? → Pending verification**, not "recovered" ([05](storyboard/05-order-pending-verification.png)).
- **Say:** "The crew completes the tasks and attaches a photo, sealed by its fingerprint. But closing the order proves nothing. The point stays pending verification."

### 5 · Verification (1:42–2:12)
- **Screen:** the same order. The panel **Simulate the measurements that would arrive afterwards** shows three choices.
- **Action:** click **Only one measurement arrives**. Pause. Then click **The repair worked**.
- **Jury sees:** first **Not enough evidence yet**, 1/3 ([06](storyboard/06-order-inconclusive.png)). Then **Repair verified with later measurements**, 3/3, SIMULATED, sealed in the Trust Ledger with its block number ([07](storyboard/07-order-repair-verified.png)).
- **Say:** "Now new measurements arrive. They are simulated here, and labeled as such. One normal reading is not enough. After three consecutive normal measurements, and with the water balance no longer showing the leak, the repair is verified and sealed with the readings behind it. If the leak had persisted, the case would reopen instead."

### 6 · Trust (2:12–2:36)
- **Screen:** click **Download the verifiable dossier**, then **See the record (Trust Ledger)**.
- **Action:** click **Simulate tampering (audit test)**, then **Verify chain integrity**. Finish with **Restore the intact chain**.
- **Jury sees:** the verdict entry *REPAIR_VERIFIED*, then **Integrity broken at block #1**, detected both in the browser and on the server ([08](storyboard/08-ledger-tamper-detected.png)).
- **Say:** "The verdict travels with its evidence in a dossier anyone can verify offline, and the verifier recomputes it instead of trusting the server. Every step is chained by SHA-256. Change one past entry, and the chain breaks, in the browser and on the server."

### Close (2:36–2:45)
- **Screen:** stay on the ledger.
- **Say:** "Aqua Sentinel shows what it knows, what it cannot claim, what was done, and whether the network really recovered."

## Shown on purpose, and left out on purpose

- **Shown:** the 3D engine panel, one incident, one work order, its verification panel, and the Trust Ledger. These cover the three claims.
- **Left out:** sensors, vision, connectivity and map screens, the terminal, and the README. None of them adds to the three claims in under three minutes.
- **REOPENED and INCONCLUSIVE** are both real outcomes. INCONCLUSIVE is shown live. REOPENED is named in the narration; `npm run demo:loop` and `src/server/repairLoop.test.ts` show it end to end.

## Where each claim lives in the code

| Claim on screen | Code | Test |
| --- | --- | --- |
| 2 / 6 / 12 L/s give no anomaly / flow anomaly / localized leak | `src/server/leakPreview.ts` (runs the real engine) | `src/server/leakPreview.test.ts` |
| Closing leaves the point pending verification | `src/server/app.ts`, `src/core/repairVerification.ts` | `src/server/repairLoop.test.ts` |
| 1 measurement → INCONCLUSIVE; 3 → VERIFIED, sealed | `src/core/repairVerification.ts` | `src/core/repairVerification.test.ts` (including property-based tests) |
| The dossier verifier recomputes the verdict | `src/core/dossier.ts` | `src/server/dossier.test.ts` |
| Tampering is detected | `src/core/cryptoLedger.ts` | `src/core/cryptoLedger.test.ts` |

## If a take goes wrong

- Delete `data/recording-state.json`, restart, and start the take again.
- The order steps can be recorded as a separate clip and joined in Clipchamp.
- `npm run demo:loop` (about 7 s, English output) runs the whole cycle offline, all three outcomes plus tamper rejection, if a backup clip is needed.

## Upload checklist (not done)

- [ ] Recorded, under 3:00, English narration (and English captions recommended)
- [ ] Shows the app running, not slides
- [ ] Uploaded to YouTube, visibility **Public**
- [ ] Link pasted in the Devpost form
- [ ] Optional: copy the final MP4 to `public/videos/`, point `public/config/intro-video.json` at it and set `"enabled": true` (see `public/videos/LEEME.txt`)
