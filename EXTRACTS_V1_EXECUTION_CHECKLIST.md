# Extracts v1 Execution Checklist

Use this checklist to decide what ships now vs later.

## 1) Entry and Flow
- [ ] Single top-level menu item: `Extracts`.
- [ ] Support 4 lanes: `Run`, `Guide`, `Build`, `Tweak`.
- [ ] First decision surface is intent-aware (chat or modal initiated).
- [ ] Keep top boilerplate block: name/description/filename/naming convention.

## 2) Persistence Rules (Hard Requirement)
- [ ] Nothing persists during draft/preview/tweak by default.
- [ ] `Approve` saves extract run record + approved summary.
- [ ] `Build/Save` saves reusable template recipe/config.
- [ ] No generated output payload is auto-persisted in KO by default.

## 3) Approvals and Summary
- [ ] Every run produces summary draft.
- [ ] Summary persisted only on approval (manual/auto/override modes supported).
- [ ] Approval provenance stored (`mode`, `by`, `at`, optional reason).
- [ ] Sensitive content only persisted via explicit approval/policy.

## 4) Auto-Approve (Fast Lane)
- [ ] Template/setup flag supports auto-approve eligibility.
- [ ] Policy gate enforces role/scope/sensitivity checks.
- [ ] Superuser override requires explicit reason + audit.
- [ ] If disqualified, flow falls back to manual review.

## 5) Test Run Governor (Cost/Perf)
- [ ] Preflight test mode defaults for new/changed flows.
- [ ] Governor caps: rows, time window, runtime (and optional LLM budget).
- [ ] Stable approved flows can run fast lane when policy allows.
- [ ] Run metadata records test/full + governor decisions.

## 6) Output Scope (v1)
- [ ] Supported formats: `md` (default), `txt`, optional `html` beta.
- [ ] Do not promise Word/PDF or external API delivery in v1 UI copy.
- [ ] Keep copy explicit: KO is operational extract workflow, not document suite.

## 7) History and Detail UX
- [ ] Searchable/sortable run history in same Extracts experience.
- [ ] List shows non-audit fields + created date.
- [ ] Row click opens detail modal using existing metadata framework.
- [ ] Detail actions: `Rerun`, `Tweak & Rerun`, `Open Setup/Template`, `Delete`.

## 8) LLM Responsibilities vs System Rails
- [ ] LLM handles intent parsing, clarification, suggestions, draft summaries.
- [ ] System enforces policy, permissions, persistence, governors, audit.
- [ ] Keep language natural in UI; avoid backend jargon in primary surfaces.

## 9) Mobile/Voice Readiness
- [ ] Mobile focuses on `Run` + `Guide`.
- [ ] Desktop handles deep `Build` and template-level `Tweak`.
- [ ] Voice intents can trigger approved fast-lane runs.

## 10) Ship Gate (Go/No-Go)
Ship v1 only if all are true:
- [ ] Core lanes work end-to-end.
- [ ] Persistence rules are enforced.
- [ ] Approve/Build semantics are unambiguous in UI.
- [ ] Governor prevents runaway cost/performance issues.
- [ ] Audit trail and approval provenance are queryable.

## Deferred (Not v1)
- [ ] External API destination delivery orchestration.
- [ ] Scheduling/batching.
- [ ] Billing/consumption UX.
- [ ] Rich format parity (docx/pdf fidelity).

