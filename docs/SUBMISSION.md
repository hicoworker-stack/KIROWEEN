# Aqua Sentinel: Kiroween 2026 submission

This is the complete submission package. **Part 1** is the text to paste into the Devpost form, in English. **Parts 2–4** map the official requirements and judging criteria to evidence anyone can check. **Part 5** is the owner's release procedure.

Status on 2026-11-26: the product is implemented and tested locally. **The repository is not yet published with this version, the app is not deployed, and the video is not recorded.** Items only the owner can supply are marked `⟨OWNER: …⟩`.

---

## Part 1 · Devpost form text

### Project name
Aqua Sentinel

### Tagline
A water-leak diagnosis that admits what it cannot conclude, and a repair that only counts once new measurements prove it.

### Category
Frankenstein. No bonus category is claimed. `⟨OWNER: add a bonus category only if you meet its separate requirements, for example a public #KiroweenHackathon26 post for Social Blitz.⟩`

### Built with
TypeScript, Node.js, Express, React 19, Vite, Tailwind CSS, three.js, Node crypto (SHA-256, Ed25519), IndexedDB, fast-check, epanet-js (EPANET 2.2), Kiro IDE. Optional and not validated with real credentials: Google Gemini (`@google/genai`).

### Links
- Code: `⟨OWNER: public GitHub URL after pushing⟩`
- Live app: `⟨OWNER: Render URL after deploying⟩`
- Video: `⟨OWNER: public YouTube URL after uploading⟩`

### About the project

**Inspiration**

Water utilities lose part of the water they put into their networks before anyone is billed for it, and leaks are one of the main reasons. World Bank studies call this non-revenue water and describe its cost to utilities. Two gaps stood out to us. Software that flags an anomaly rarely says how sure it is, or when it cannot tell a leak from a drifting meter. And in a report-and-close workflow, a repair counts as done when the ticket closes, so nothing checks whether the network actually recovered. We wanted a tool that is honest at both ends.

**What it does**

Aqua Sentinel follows one incident from start to finish:

1. **It detects and diagnoses, and says when it cannot conclude.** A water balance between meters, with propagated uncertainty, plus a check that the pressure drop matches the physics. A small loss is reported as *no anomaly*: it is below what the meters can detect. A medium one is a *flow anomaly* that the engine refuses to call a leak, because pressure cannot confirm it. Only a loss whose pressure response matches is a *localized leak* on a specific pipe.
2. **A person decides.** The incident shows the evidence channels, the alternative explanations still open, and what data is missing. A photo that no vision model analyzed is shown as *not used as evidence*. Accepting the recommendation creates a work order with tasks, an owner and a required closing photo.
3. **Closing the order proves nothing.** The point stays *pending verification*.
4. **New measurements decide.** One normal reading is *INCONCLUSIVE*. Three consecutive normal readings, with the water balance no longer showing the leak, give *VERIFIED*. Two anomalous readings, or a balance that still shows the leak, give *REOPENED*. The rule is a pure function, and the verdict is sealed with the readings that justify it.
5. **The evidence can be checked by someone else.** Every step is chained with SHA-256 in a Trust Ledger, and closings are signed with Ed25519. The exported dossier can be verified offline, and the verifier recomputes the repair verdict from the sealed readings instead of trusting the server. Change one past entry, or the verdict, and verification fails.

Everything in the demo is synthetic and labelled SIMULATED: the network, the readings, the leak and the post-repair measurements.

**How we built it**

The Frankenstein part is that several pieces that rarely meet sit in one app, each with a job:

| Piece | Its job | Where |
| --- | --- | --- |
| Hazen-Williams hydraulic solver, cross-checked against EPANET 2.2 | Physically consistent synthetic telemetry | `src/sim/` |
| Deterministic rules + mass balance with uncertainty | Detection that refuses to over-claim | `src/core/hydraulicDiagnosis.ts`, `deterministicEngine.ts` |
| Evidence concordance | A support level from agreeing channels, never an invented percentage | `src/core/evidenceConcordance.ts` |
| Repair verification | `PENDING`, `INCONCLUSIVE`, `VERIFIED`, `REOPENED` | `src/core/repairVerification.ts` |
| SHA-256 ledger, Ed25519 receipts, offline dossier verifier | Tampering is detectable by a third party | `src/core/cryptoLedger.ts`, `src/core/dossier.ts` |
| Optional generative AI | Wording and hypotheses only, never priority, support level or verdict | `src/server/aiProvider.ts` |
| Offline-first field reports | Reports queued on the device and synced without duplicates | `src/core/offlineStore.ts` |
| three.js 3D model | Renders the real engine's output; contains no physics of its own | `src/components/sim3d/`, `src/server/leakPreview.ts` |

The core has no server, simulation or React imports, and a test enforces that. The interface is bilingual (English and Spanish). Engine text is sealed in its original language so hashes never change, and it is translated only when displayed.

**Challenges we ran into**

- Not over-claiming. A medium loss creates a flow imbalance that pressure cannot confirm, and that a drifting meter could also produce. The diagnosis requires the pressure response to match the estimated loss, and otherwise reports a flow anomaly instead of a leak.
- Making "verified" mean something. A hash chain shows whether the record was altered after the fact, not whether the verdict was right. So the verifier recomputes the verdict from the sealed readings, and a dossier with a perfect chain but a verdict that does not follow from its own evidence is rejected.
- Translating without breaking the evidence. Translating engine text at the source would have changed the sealed hashes, so translation happens only in the presentation layer.

**Accomplishments that we're proud of**

- The solver matches EPANET 2.2 in 8 cases within 0.0027 bar and 0.0007 L/s.
- The dossier verifier rejects 21 distinct tampering attacks, which are kept as regression tests.
- `npm run demo:loop` drives the whole cycle through the real API, offline and without API keys, and produces all three verdicts plus two rejected tamperings in about ten seconds.

**What we learned**

Saying "I cannot conclude" is a feature. It is also testable: property-based tests check that `VERIFIED` never appears without three usable post-closure measurements, whatever series is thrown at it.

**What's next**

Validation with real network data from a utility partner, calibration of the 3-normal / 2-anomalous policy on real repairs, and exporting dossiers to a system the operator does not control. None of this has been done yet.

### How we used Kiro (required write-up)

- **Kiro IDE.** The final integration and audit phase was done with the Kiro agent in Kiro IDE: the repair-verification loop, the engine-driven 3D model, the bilingual presentation layer, and a release audit that found and fixed real defects. `⟨OWNER: describe how you used Kiro in the first days (Nov 18–23), and whether you tried CLI, Web or Crew.⟩`
- **Spec-driven development.** `.kiro/specs/` holds 12 specifications with 89 requirements (`REQ-*`). Each requirement has a traceability row naming the code and the test that covers it. `npm run verify:kiro` turns this into a gate. It fails if a requirement is defined twice, has no row, cites a file that does not exist, or cites a test that never mentions it. Then it runs all tests, the type-check and the build. The gate itself has been audited: it once skipped two requirements whose IDs contained digits, and we fixed the IDs so the tool really checks all 89. Spec 12 was written after its implementation, and it says so. `⟨OWNER: one or two sentences on how specs compared with vibe coding for you.⟩`
- **Steering.** `.kiro/steering/water-domain-rules.md` holds 23 domain rules that shape every answer. Examples: "distinguish measured evidence from inference and missing data", "no recovery without measurement", "nothing is simulated silently". Key rules are backed by tests, so breaking them fails the build instead of depending on the agent remembering them. For example, the repair-loop tests fail if a point is shown as recovered without post-closure measurements, and the intro-video tests fail if a missing video is replaced by a fake playback.
- **Property-based testing.** fast-check properties on the repair verdict: `VERIFIED` requires three usable post-closure measurements; data older than the closing never changes a verdict; arrival order does not matter; a later pair of anomalous readings reopens a verified repair; and a sealed verdict always recomputes to itself. `⟨OWNER: if a property ever failed and revealed a bug, say which.⟩`
- **Agent hooks.** We did not use Kiro event hooks. `.kiro/hooks/verify-integrity.json` is the check list that `npm run verify:kiro` runs, read by our own script.
- **Custom agents, MCP, Powers, Kiro Crew.** Not used. The project did not need them, and we chose not to add them for appearance.

### Testing instructions for judges

**Fastest: no install.** Open `⟨OWNER: Render URL⟩`. Anyone can browse in read-only mode. To run the full cycle, log in as `judge` / `⟨OWNER: judge password, shared only here⟩`. Then:
1. On Home, scroll to the 3D model, click **Next step** twice and move **Simulated leak size** to 2, 6 and 12 L/s.
2. Open **Work orders**: the demo includes an order in progress. Tick its tasks, add any photo, then **Close the order** → **Yes, close the order**. It shows *Pending verification*.
3. In **Simulate the measurements that would arrive afterwards**, click **Only one measurement arrives**, then **The repair worked**.
4. Click **See the record (Trust Ledger)**, then **Simulate tampering (audit test)** and **Verify chain integrity**.

**Locally, offline, without API keys** (Node 22 or later):
```bash
npm ci
npm run demo:loop       # the whole cycle, three verdicts, two rejected tamperings (about 10 s)
npm run dev -- --open   # the app at http://127.0.0.1:3000 with a local guest session
npm test                # 452 tests
npm run verify:kiro     # spec → code → test traceability, then tests, types and build
```

All data is synthetic. Gemini is optional; without a key, diagnoses use the deterministic adapter and photos stay "not analyzed", and the interface says so.

---

## Part 2 · Official requirements → evidence

Source: [official rules](https://kiroween.devpost.com/rules), read on 2026-11-25. On 2026-11-26 the page returned HTTP 403 to our tools, so re-read it before submitting.

| Requirement (paraphrased from the rules) | Evidence in Aqua Sentinel | Status |
| --- | --- | --- |
| Working software built with Kiro, in one category | This app; Frankenstein; `.kiro/` with specs and steering | Ready |
| New project, built in the submission period; disclose pre-existing code | First commit 2026-11-18 (`27fd307`); history not edited | `⟨OWNER: confirm that no code predates Oct 30, or disclose it⟩` |
| URL to the functional application; judge credentials in the form if needed | `render.yaml` + `Dockerfile`; `AQUA_JUDGE_PASSWORD` creates an OPERATOR account | **Not deployed** (Part 5) |
| Text description of features and functionality | Part 1 | Ready |
| Video under 3 minutes, showing the project working, public on YouTube, no copyrighted music or third-party marks | `docs/DEMO_SCRIPT.md` (2:45, rehearsed click by click) | **Not recorded** |
| Public GitHub repository with all code, assets and instructions | 195 tracked files; README with run instructions | **Not pushed** (Part 5) |
| Open-source license detectable in the repository's About section | `LICENSE` (MIT), `license` in `package.json` | Ready locally; GitHub detects nothing until it is pushed |
| `/.kiro` at the root and not in `.gitignore` | 14 files tracked; `.gitignore` does not list it | Ready |
| Write-up on how Kiro was used | "How we used Kiro" in Part 1 | Ready, with owner items |
| Identify category and bonus category | Part 1 | Ready |
| All materials in English | Part 1, README, video script; UI language switch | Ready |
| Eligibility by country of residence (the rules exclude some places, including Argentina, Brazil, Italy, the Philippines and others) | Cannot be checked by us | `⟨OWNER: confirm⟩` |
| Deadline | Submission period October 30 to December 4, 2026 | `⟨OWNER: confirm the exact hour on the Devpost page⟩` |

The rules also say judges may score from the text, images and video alone, without testing the app. Part 1 and the video therefore carry most of the weight.

## Part 3 · Judging criteria → what a judge can observe

The five criteria weigh equally (20% each, 10 points). Note that **Technological Implementation is defined by the rules as the use of Kiro**: strategy for AI-assisted development, variety of Kiro tools, depth of understanding, experimentation.

| Criterion | What the judge can see | Where |
| --- | --- | --- |
| Potential Impact | A real problem (unbilled water, unverified repairs), named beneficiaries, and a demo in which the verdict follows from measurements | Video scenes 1, 4–5; Part 1 |
| Technological Implementation | Specs enforced by a gate, steering rules backed by tests, property-based tests; no hooks, MCP or custom agents | Part 1 "How we used Kiro"; `.kiro/`; `npm run verify:kiro` |
| Design | One coherent flow: incident → order → verification → ledger; provenance labels on every datum; bilingual UI; works on mobile | Video; `docs/storyboard/` |
| Innovation / Idea | A verdict that must be earned by later measurements and can be recomputed by a third party | Video scenes 5–6; `src/core/repairVerification.ts`, `src/core/dossier.ts` |
| Presentation | One story in 2:45 | `docs/DEMO_SCRIPT.md` (video not yet recorded) |

## Part 4 · Claims → evidence

| Claim | How to check it |
| --- | --- |
| 2, 6 and 12 L/s give no anomaly, flow anomaly and localized leak | 3D model step 3; `src/server/leakPreview.test.ts` |
| Closing an order leaves the point pending verification | `src/server/repairLoop.test.ts` |
| 1 measurement → INCONCLUSIVE; 3 → VERIFIED; persistent leak → REOPENED | `npm run demo:loop`; `src/core/repairVerification.test.ts` |
| The verifier recomputes the verdict and rejects a false one | `src/server/dossier.test.ts`; `npm run demo:loop` |
| 21 tampering attacks are rejected | `src/server/dossier.test.ts` |
| Solver agrees with EPANET 2.2 within 0.0027 bar and 0.0007 L/s in 8 cases | `src/sim/epanetValidation.test.ts` (asserts ≤ 0.005 bar and ≤ 0.002 L/s; maximum measured on 2026-11-26) |
| Public visitors are read-only; judge is OPERATOR without admin rights | `src/server/accessModel.test.ts`, `security.public.test.ts`; production smoke test on 2026-11-26: 22/22 |
| Displayed engine text is English when English is selected | `src/server/engineText.coverage.test.ts`, `src/ui/views.test.tsx` |
| 89 requirements traced to code and tests | `npm run verify:kiro` |

### Public sources for the problem (context, not results of this project)

Each was read at the source on 2026-11-25 and is paraphrased here.
- World Bank, *The Challenge of Reducing Non-Revenue Water in Developing Countries: How the Private Sector Can Help* (Kingdom, Liemberger and Marin, 2006), [Open Knowledge Repository](https://openknowledge.worldbank.org/entities/publication/bba46a1a-4a9a-59b4-968f-306e32b1338f). It defines non-revenue water as the gap between the water put into the distribution system and the water billed, caused by leaks, unbilled water or both, and says it hurts utilities' finances.
- World Bank, *Reducing Water Loss in Developing Countries Using Performance-Based Service Contracting* (Kingdom, Liemberger and Marin, 2008), listed on the same page. Its abstract puts the worldwide cost of non-revenue water at a conservative USD 15 billion per year.
- World Bank blog, ["What is non-revenue water? How can we reduce it for better water service?"](https://blogs.worldbank.org/en/water/what-non-revenue-water-how-can-we-reduce-it-better-water-service), written for World Water Week 2016. It describes contracts paid on results, and a project in Ho Chi Minh City that halved the water lost to leakage (about 100,000 m³ per day).

We do not quote global volume figures (for example Liemberger and Wyatt, 2019, *Water Supply* 19(3), doi:10.2166/ws.2018.129) because the full paper could not be opened from here.

### What we do not claim

- No real users, pilots, field data, accuracy figures or water savings. Intended beneficiaries (operators of small and medium systems, auditors, residents) have not used the product.
- No use of AWS. The AWS adapters in the code are labelled simulated. Gemini is optional and has never been validated with real credentials.
- No immutability: the chain and signatures detect tampering by others, not by whoever controls the server.
- The 3-normal / 2-anomalous policy is a documented design choice, not a calibrated value.

---

## Part 5 · Owner release procedure

### 5.1 Publish the code (choose one repository)

State on 2026-11-26: branch `main`, clean, `HEAD` = latest local commit. Both remotes are ancestors of `HEAD`, so either push is a plain fast-forward; no force is needed.

| Remote | Repository | Pending commits (check with) | Who can push |
| --- | --- | --- | --- |
| `upstream` | FRANKPIERRECARDENAS/KIROWEEN (original, public) | `git rev-list --count upstream/main..HEAD` | The account currently logged in (admin) |
| `origin` | hicoworker-stack/KIROWEEN (public fork) | `git rev-list --count origin/main..HEAD` | Only an account with write access to that fork |

```bash
git status                       # must be clean
git push upstream main           # option A: updates FRANKPIERRECARDENAS/KIROWEEN
git push origin main             # option B: only from an account with write access to hicoworker-stack/KIROWEEN
```

Then open the repository page and check that **MIT** appears in About, that `.kiro/` is visible, and that the README renders. Use that URL in the form.

### 5.2 Deploy

What was verified locally on 2026-11-26, without Docker: production + public mode + judge account, 22 of 22 checks. That covers read-only public access, 401 for anonymous protected routes and writes, 421 for an unknown host, no secrets in the public state, judge login as OPERATOR, 403 on reset and export, and the full cycle through to a valid dossier. **Docker was not available, so the image has never been built.**

1. Build once where Docker exists:
   `docker build -t aqua-sentinel .` then `docker run -p 8080:8080 -e AQUA_ALLOWED_HOSTS=localhost:8080 -e AQUA_ALLOWED_ORIGINS=http://localhost:8080 -e AQUA_JUDGE_PASSWORD=<12+ characters> aqua-sentinel`, and open `http://localhost:8080/api/health`.
2. On Render, create the service from `render.yaml`. Set `AQUA_ALLOWED_HOSTS` and `AQUA_ALLOWED_ORIGINS` to the **exact** subdomain Render assigns. Render's health check sends that `Host`, so a mismatch returns 421 and the deploy never becomes healthy.
3. In the dashboard, set the secrets `AQUA_JUDGE_PASSWORD` (12+ characters) and, so receipts survive restarts, `AQUA_SEAL_PRIVATE_KEY_PEM`. Neither belongs in the repository.
4. The free plan has an ephemeral disk: the demo is reseeded on restart.
5. Behind Render's proxy all visitors share one IP, and the proxy IPs are not fixed, so `AQUA_TRUSTED_PROXIES` cannot be set. `render.yaml` raises the per-IP login limit; the per-account limit (8 failed logins in 15 minutes) still protects `judge`.
6. Open the URL, log in as `judge`, run the four testing steps from Part 1, then put the URL and credentials in the form.

### 5.3 Record and publish the video

Follow `docs/DEMO_SCRIPT.md`: clean state, exact clicks, narration, timings, and reference screenshots in `docs/storyboard/`. Record with your own voice, upload to YouTube as **Public**, and paste the link. Optionally copy the final MP4 into `public/videos/` and re-enable it on Home (see `public/videos/LEEME.txt`).

### 5.4 Fill in the form

Paste Part 1. Replace every `⟨OWNER: …⟩`. Select Frankenstein. Re-read the rules page and submit before the deadline.
