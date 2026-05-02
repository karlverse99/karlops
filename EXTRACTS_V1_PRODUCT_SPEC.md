# KarlOps Extracts v1 Product Spec

## Purpose
Define a simple, fast, and secure Extracts experience that is easy for normal users, powerful for super users, and predictable to rerun.

## Product Goals
1. Get users to outcome quickly.
2. Store the right prompt + recipe/config for reproducible runs.
3. Allow full LLM-assisted tweak/build flows inside guardrails.
4. Handle data security and approval explicitly.

## Core User Language
- Run
- Guide
- Build
- Tweak

Do not lead with backend object terms in primary UX.

## Concept Model (Internal)
- Template: reusable design/layout and defaults.
- Recipe (internal term): data scope + filters + prompt/instructions + output options.
- Extract Run Record: execution history and metadata.
- Summary: approved narrative of what was done.

UI may use "Setup" instead of "Recipe" where needed.

## Entry Model
Single top-level menu: `Extracts`.

Entry lanes:
1. Run - execute known flow quickly.
2. Guide - user describes intent; Karl guides.
3. Build - make reusable logic for future use/team.
4. Tweak - preview current outcome, change, re-preview, rerun.

Intent source can be chat or modal; first decision surface should be intent-aware.

## First Decision Surface (Contextual)
Not a universal static home screen. The first visible step after intent resolution should adapt:
- Run intent: "Ready to run this extract?"
- Build intent: "Let's build this for reuse."
- Guide intent: "Tell me what you need done."
- Tweak intent: "What do you want to change?"

## My Universe / History Behavior
Within Extracts, show run history and related items.

Requirements:
- Searchable, sortable list.
- Display non-audit fields + created date.
- Type icon/label via context registry.
- Row click opens detail modal.

Detail modal actions:
- Rerun (with preview)
- Tweak & Rerun
- Open Setup/Template
- Delete record (permission-based)

Use existing metadata display framework. Hide system internals (UUID/FK/audit IDs) from standard views.

## Persistence Contract (Critical)
Default: nothing persists during drafting/preview/tweak.

Persist on explicit action only:
- Approve (after run): saves extract run record + approved summary.
- Build/Save: saves template recipe/config for reuse.

No auto-saving of generated output payload by default.

## Approve / Build Semantics
- Run with Data: execute against current data state.
- Approve: commit run history (record + approved summary).
- Build: commit reusable recipe/template logic.
- Approve + Build: do both in one flow.

Two-table responsibility:
- Template table: reusable logic ("how to do it").
- Extract table: run history + approved summary ("what happened").

## Summary Policy
Always produce a summary draft after each run.

Store only approved summary content:
- Approve directly, or
- Edit/regenerate then approve.

Track provenance:
- approval_mode (manual/auto/override)
- approved_by
- approved_at
- override_reason (when applicable)

Sensitive content may be stored only when explicitly user-approved (or policy-authorized auto-approve).

## Auto-Approve Design
Add template/setup flag, e.g. `auto_approve_enabled`.

Auto-approve allowed only when:
- template/setup flag is on
- policy permits for user/scope
- no disqualifying change since approved baseline (unless explicit override)

Superuser override allowed with explicit reason and full audit.

## Test Run Governor (Performance/API Cost)
Preflight governor for test mode:
- row caps
- time-window caps
- runtime budget
- optional token/call caps for LLM steps

Defaults:
- new/changed flows run in test mode first
- stable approved flows may use fast lane

Record run mode and governor decisions in run metadata.

## Output Scope (v1)
Keep output formats intentionally narrow:
- markdown (default)
- txt
- html (optional/beta)

Do not promise Word/PDF/API delivery in v1.

## External Delivery
Deferred to later phase.

If needed in future:
- treat delivery as first-class step
- store delivery metadata only (not payload by default)

## LLM Role vs System Rails
LLM handles:
- intent parsing from natural language
- clarifying questions
- suggestions and tweak assistance
- summary drafting

System enforces:
- persistence rules
- approvals and policy checks
- permissions
- governor limits
- allowed formats
- audit/provenance

Principle: LLM chooses path; system enforces policy.

## Voice + Mobile Direction
Mobile-first lanes:
- Run
- Guide

Desktop-first lanes:
- Build
- Tweak Template

Approved/stable setups should support low-friction "Run Now" flows for recurring operational use.

## v1 Acceptance Criteria
1. User can complete Run/Guide/Build/Tweak from Extracts entry.
2. No persistence occurs before explicit Approve/Save.
3. Approve saves run record + approved summary.
4. Build saves reusable recipe/template logic.
5. Auto-approve is policy+flag gated and auditable.
6. Test governor limits cost/performance risk.
7. Output formats limited to md/txt/(optional html).
8. History/detail views use existing metadata framework and hide system internals.

## Out of Scope (v1)
- Word/PDF formatting guarantees.
- Full external API integration and destination orchestration.
- Full billing/consumption UX.
- Complex scheduling/batching (can be future).

