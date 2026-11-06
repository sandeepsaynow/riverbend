# Submission email (ready to send)

**Subject:** Riverbend Cycles — Senior Engineer take-home submission

---

Hi,

Thanks again for the take-home. My submission for the Riverbend Cycles multi-tenant work-order intake is below.

**Repository:** https://github.com/sandeepsaynow/riverbend
**Walkthrough (Loom, ~6 min):** https://www.loom.com/share/25f9ad79d7fc48cabbaa91c5a299f054

**Run it locally (one command, no API key needed):**

```sh
ADMIN_BOOTSTRAP_TOKEN=some-long-random-secret make up   # Postgres + api + worker; migrates, seeds, serves http://localhost:8080
# equivalently: docker compose up --build
```

The default run is fully offline and deterministic (the AI uses an in-process `FakeGateway`); real OpenAI and Resend
activate only when their keys are set. The README's "Reviewer — start here" section has the end-to-end demo.

**Key documents:**
- Architecture note (2 pages, diagram, data model, tenant isolation, 3 decisions to challenge): [`docs/architecture.md`](https://github.com/sandeepsaynow/riverbend/blob/main/docs/architecture.md)
- 40-message evaluation (deterministic + real-model run, per-tenant cost): [`docs/evaluation-results.md`](https://github.com/sandeepsaynow/riverbend/blob/main/docs/evaluation-results.md) and [`docs/MODEL_COST_REPORT.md`](https://github.com/sandeepsaynow/riverbend/blob/main/docs/MODEL_COST_REPORT.md)
- GCP deployment + Terraform (deployed and verified on staging, then torn down): [`docs/gcp-deployment.md`](https://github.com/sandeepsaynow/riverbend/blob/main/docs/gcp-deployment.md) and [`docs/GCP_STAGING_DEPLOYMENT_REPORT.md`](https://github.com/sandeepsaynow/riverbend/blob/main/docs/GCP_STAGING_DEPLOYMENT_REPORT.md)
- What I deliberately did not build + what breaks first at 100 shops: [`docs/not-built.md`](https://github.com/sandeepsaynow/riverbend/blob/main/docs/not-built.md)

Tests: `npm test` runs the full suite (246 passing) against real PostgreSQL via Testcontainers.

The Loom covers one AI decision I overrode — swapping content-fingerprint idempotency for explicit client-generated
submission identifiers — with the reasoning and the code behind it (`docs/AI_DECISION_OVERRIDE.md`).

Happy to do the 60-minute technical walkthrough whenever suits you — I can run the stack live, show the tenant-isolation
and budget guarantees, and walk the AI pipeline and the three decisions I flagged as worth challenging.

Best,
Sandeep
