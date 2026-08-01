# Autonomous Project Bootstrap

This branch converts Project Mode creation into an automated, subscription-backed ChatGPT Web bootstrap pipeline.

Planned behavior:

1. Create fresh planner, reviewer, and integrator ChatGPT conversations when role chats are not supplied.
2. Send bounded role initialization prompts and persist the verified conversation IDs.
3. Submit the planner prompt automatically.
4. Parse and validate the planner envelope.
5. On malformed JSON, send a bounded repair prompt to the same planner chat and retry.
6. Approve only schema-valid plans, then materialize tasks.
7. Keep model selection, destructive repository actions, and platform-limit handling fail-closed.
