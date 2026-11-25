# Aqua Sentinel: Kiroween 2026 submission notes (Frankenstein)

## One sentence

Aqua Sentinel connects a hydraulic diagnosis to the repair and then **demands later measurements before it will say the repair worked**, sealing that verdict, with the readings behind it, in a cryptographic dossier anyone can verify offline.

## What problem, for whom

Community water boards lose water to leaks nobody sees, and a repair is usually "done" when the crew leaves. Aqua Sentinel is for the people who operate those systems and for whoever has to audit them afterwards. The demo uses a synthetic network (*San Cristóbal de las Aguas*); **we make no claim about real users, pilots, savings or field accuracy.**

## The stitched-together parts (Frankenstein)

| Piece | What it contributes | Where |
| --- | --- | --- |
| Hydraulic solver (Hazen-Williams), cross-checked against EPANET 2.2 | Physically consistent synthetic telemetry | `src/sim/` |
| Deterministic rules + mass balance with propagated uncertainty | Detection that refuses to over-claim | `src/core/deterministicEngine.ts`, `hydraulicDiagnosis.ts` |
| Evidence concordance (sensors, hydraulics, photo, field report) | A support level with no invented percentages | `src/core/evidenceConcordance.ts` |
| Repair verification | `PENDING / INCONCLUSIVE / VERIFIED / REOPENED` from post-closure measurements | `src/core/repairVerification.ts` |
| SHA-256 ledger, Ed25519 receipts, dossier verifier | A verdict that cannot be altered without detection by a third party | `src/core/cryptoLedger.ts`, `dossier.ts`, `src/server/dossierVerify.ts` |
| Generative AI (optional, unvalidated) | Hypotheses and wording only; never priority, evidence level or verdict | `src/server/aiProvider.ts` |
| Offline-first field reports | Declared reports queued on-device and synced idempotently | `src/core/offlineStore.ts` |
| 3D model | The whole story, rendered from the real engines' output | `src/components/sim3d/` |

AWS is not used. The AWS adapters in the repository are labelled simulated, and we do not count them as integrations.

## How to run it (for judges)

```bash
npm ci
npm run demo:loop         # offline: the full cycle, three outcomes, real engines
npm run dev -- --open     # the app, guest session, local only
```

On a deployed instance (public mode is read-only), the operator sets `AQUA_JUDGE_PASSWORD` and shares the credentials in the Devpost form (user `judge`, role `OPERATOR`). Use it to run the cycle in the app.

## How Kiro was used

- **Specs:** 12 specs, 89 `REQ-*` requirements, each traced to code and to a test that names it. `npm run verify:kiro` fails if any requirement is defined twice, has no row, cites a missing file, cites no test, or cites tests that never mention it. Spec 12 was written after its implementation and says so.
- **Steering:** 23 domain rules (`.kiro/steering/water-domain-rules.md`) such as "no recovery without measurement" and "nothing is simulated silently". Tests enforce them, so they are not just prose.
- **Hooks:** `.kiro/hooks/spec-traceability-on-save.json` re-runs the traceability test whenever a spec or a test file is saved.
- **Property-based testing:** `fast-check` on the repair-verification invariants (never `VERIFIED` without three usable post-closure measurements; stale data and arrival order never change a verdict; a sealed verdict always recomputes to itself).
- **What we did not use:** MCP servers, custom agents, Kiro Crew, powers. We did not need them and will not pretend otherwise.

## 3-minute demo script

The full storyboard (screen, presenter action, what the jury sees, English narration, timing) is in [`docs/DEMO_SCRIPT.md`](DEMO_SCRIPT.md). It was checked against the current interface on 2026-11-25. **The video has not been recorded yet.**

## Language of the interface

The interface is bilingual. English is used when the browser language is not Spanish, or with `?lang=en`; the EN/ES switch is in the header. One string table (`src/ui/i18n.ts`) serves both languages, with no duplicated components.

Text written by the server and the engine (diagnoses, hypotheses, checklist tasks, verification messages, ledger summaries, verifier checks, API errors) is stored and sealed in Spanish. Changing it at the source would change the ledger hashes and the engine output, so it is translated **only when displayed**, by `src/ui/engineText.ts`. That layer imports nothing from the engine, matches known sentence templates, keeps every number and identifier, and leaves unrecognized text unchanged. `src/server/engineText.coverage.test.ts` runs the real server through the full cycle (three verdicts, dossier, other scenarios, 3D preview) and fails if any displayed sentence still contains Spanish.

Left in the original language on purpose: proper names of the synthetic network (nodes, sectors, the network name), text typed by people (closing notes, assignee names) and the raw contents of `.kiro/` files shown in the connectivity tab.

On 2026-11-25 every route (Home with the 3D model, Map, Incidents, Work orders, a verified, a reopened and an inconclusive order, Trust Ledger, Evidence, Sensors, Connectivity, Demonstration) was loaded in English at 1440 px and 390 px. The only Spanish found was the names above.

## Impact: problem, who benefits, and what is evidence

**Public sources (context, not results of this project):**
- Liemberger, R. and Wyatt, A. (2019), "Quantifying the global non-revenue water problem", *Water Supply* 19(3), IWA Publishing. Their estimate is about 346 million m³ per day, or 126 billion m³ per year, with a conservative value of about USD 39 billion per year at USD 0.31/m³. Non-revenue water includes leaks, but also unbilled and unauthorized use, so it is not all physical loss.
- World Bank blog, ["What is non-revenue water? How can we reduce it for better water service?"](https://blogs.worldbank.org/en/water/what-non-revenue-water-how-can-we-reduce-it-better-water-service) (2024): it cites a World Bank estimate of about 32 billion m³ of physical losses per year, half of it in developing countries.

We read these figures from search results and the World Bank page on 2026-11-25, not from the full papers. Check them against the originals before quoting them in the video or the Devpost text. Aqua Sentinel's own results contain no percentages, savings or user numbers.

- **Problem.** A large share of treated water never reaches a customer, and hidden leaks are a main physical cause. A repair is usually recorded as done when the crew closes the ticket, and nobody checks that the network recovered.
- **Who benefits.** Operators of small and medium water systems, who have few analysts and need to know where to send a crew. Municipal oversight and auditors, who need a record they can check without trusting the operator. Residents, who feel the result as pressure and supply. These are intended beneficiaries; none of them has used the product.
- **Use case.** A pressure drop at one node and a flow imbalance in the same area. The engine separates a leak from a sensor fault or a demand change, says when it cannot conclude, proposes a location, a person decides, and later measurements confirm or reject the repair.
- **Against a conventional report-and-close system.** There, a ticket closes when the crew leaves. Here the point stays "pending verification" until three consecutive usable measurements agree and the water balance no longer shows the leak, and anyone holding the dossier can recompute that verdict.
- **Evidence status.** Synthetic: the network, the readings, the leak, the post-repair measurements (all labelled SIMULATED in the interface). Public data: only the context figures above. Real validation: none. There is no field pilot, no real utility data and no measured savings.

## What we do not claim

- No real users, interviews, pilots, field data, accuracy or water savings.
- No production use of AWS, Bedrock or Gemini. Gemini is optional and has never been validated against real credentials in this repository.
- No immutability: the hash chain and signatures detect tampering by others, not by whoever controls the server.
- The verification policy (3 normal, 2 anomalous) is a documented design choice, not a calibrated value.


## Eligibility checklist

Checked against the [official rules](https://kiroween.devpost.com/rules) on 2026-11-25.

- [x] Open source license: `LICENSE` (MIT) and `license` in `package.json`. The rules also ask that GitHub detects it in the repository's About section; **check that after pushing**.
- [x] `.kiro/` at the repository root, not ignored (`.gitignore` does not list it).
- [x] README in English with install and run instructions.
- [x] Category: Frankenstein. The rules ask for a chimera of technologies; the table above lists them.
- [x] "New projects only": the first commit is dated 2026-11-18, inside the submission period (Oct 30 – Dec 4, 2026). The history is not edited. **The owner must confirm that no code predates Oct 30**; the rules require disclosing any pre-existing code.
- [ ] Public GitHub repository URL. `origin` is `https://github.com/hicoworker-stack/KIROWEEN.git`, which fetched without credentials earlier, which suggests it is public. **The owner must confirm.**
- [ ] Demo video: under 3 minutes, public on YouTube, showing the project running, no third-party copyrighted music. **Not recorded.** Script: `docs/DEMO_SCRIPT.md`.
- [ ] Deployed URL, plus judge login and instructions in the Devpost form. **Not deployed.** See the next section.
- [ ] Personal eligibility. The rules list places where entrants cannot participate or receive a prize (they include Argentina, Brazil, Italy and others). **The owner must read that list against their country of residence.** We cannot check it.
- Deadline: December 4, 2026, 2:00 PM Pacific Time.

## Deployment (prepared, not performed)

`Dockerfile` and `render.yaml` run the app in public read-only mode with synthetic data. Docker is not installed on the development machine, so the image has not been built here. What was verified instead: the production server (`NODE_ENV=production`, same entry point as the Dockerfile) is started by the end-to-end tests, which cover host and origin allow-lists, secure cookies, the read-only public routes, and rejection of writes.

To go live, the owner needs a Render account (or any Docker host) and must:
1. Create the service from `render.yaml` and set `AQUA_ALLOWED_HOSTS` and `AQUA_ALLOWED_ORIGINS` to the real domain.
2. Set `AQUA_JUDGE_PASSWORD` (12+ characters) as a secret in the dashboard. It creates the `judge` account with role OPERATOR. It must never be committed.
3. Know that the free plan has an ephemeral disk: state is reseeded on restart. Export a snapshot before recording.
4. Open the URL, run the cycle once, and check `/api/health`.
