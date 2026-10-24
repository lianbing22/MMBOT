# MMBOT industry template library

Each template is a ready-to-run Bot team: names, roles, directly usable Chinese prompts, group composition and starter prompts. Three packs ship today — [medical follow-up](medical-followup.json), [order delivery](order-delivery.json) and [manufacturing inspection](manufacturing-inspection.json).

Landing one takes about three minutes: create the Bots (paste each `instructions` verbatim, make the lead a Main Bot), create the groups with their members, then send the first `starterPrompts` line to the lead. The schema and validation rules — unique Bot names, valid group references, prompts of real length — are enforced by `node scripts/check-templates.mjs`; drop a new JSON in this directory and it is picked up.

The [Chinese README](README.zh.md) is the primary document, with a field-by-field schema and customization advice.
