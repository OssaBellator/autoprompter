# Autonomous Project Bootstrap

AutoPrompter 3.0 converts Project Mode creation into an automated, subscription-backed ChatGPT Web bootstrap pipeline.

Behavior:

1. Create fresh planner, reviewer, and integrator ChatGPT conversations when role chats are not supplied.
2. Send bounded role initialization prompts and persist the verified conversation IDs.
3. Submit the planner prompt automatically.
4. Parse and validate the planner envelope.
5. On malformed JSON, send a bounded repair prompt to the same planner chat and retry.
6. Approve only schema-valid plans, then materialize tasks.
7. Keep model selection, destructive repository actions, and platform-limit handling fail-closed.

## Implemented pipeline

Project creation now starts an asynchronous browser-backed bootstrap. It creates or reuses the three fixed-role chats, verifies their conversation IDs, initializes their roles, submits the planner prompt, and retries malformed planner envelopes up to three times. Only a schema-valid plan is approved and materialized. When worker chats exist, the local project starts and its first assignment wave is prepared without sending those worker prompts.

## Validation

The exact source passed 115 automated tests, JavaScript syntax checks, JSON validation, version checks, source-blob verification, and the guarded staged-diff audit. The regression suite includes a complete simulated bootstrap in which the first planner response contains malformed JSON, the same planner chat receives an automatic repair request, the corrected plan is approved, and a worker assignment is prepared without bypassing model verification.
