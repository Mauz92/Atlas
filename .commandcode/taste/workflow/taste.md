# Workflow preferences

- Prefers milestone-based development with explicit approval gates; a milestone must pass its acceptance criteria before the next one begins. Confidence: 0.95
- Wants an architecture/spec approval gate before implementation starts. Confidence: 0.9
- Breaks work into small, reviewable tasks that each carry acceptance criteria and test requirements. Confidence: 0.9
- Writes automated tests alongside implementation rather than after the fact. Confidence: 0.9
- Expects tests, type checking and linting to be run before declaring a task complete. Confidence: 0.95
- Requires test evidence or a documented manual verification before any feature is claimed to work; never report a test or deployment that was not actually performed. Confidence: 0.95
- Maintains living documentation (spec, architecture, data model, decision log, risk register, roadmap, changelog) and expects it kept consistent with the code. Confidence: 0.9
- Records limitations and partially-implemented features explicitly instead of overstating completeness. Confidence: 0.9
- When blocked, wants the exact blocker, the evidence collected, the options, and a recommended next action. Confidence: 0.9
- Avoids speculative features that are outside the approved roadmap/scope. Confidence: 0.9
- Prefers work to be done completely and rigorously ("no shortcuts") — closing out the full scope and remediating real defects rather than taking expedient paths, even when thoroughness surfaces additional work. Confidence: 0.8
- Prefers preserving a reproducible, working state at each milestone. Confidence: 0.85
- Insists that planned end-to-end verification actually be executed (e.g. "run the docker container then") rather than left as a documented "not run" when it can be pursued, and is willing to perform privileged setup steps themselves (such as adding their user to the docker group) to unblock the agent. Confidence: 0.7
- Prefers autonomous, self-paced orchestration loops for multi-task work: delegate one background subagent per task and keep spawning the next as each finishes, polling progress on a fixed short cadence (e.g. every ~5 minutes) and continuing until every milestone/gate is complete. Confidence: 0.8
- Expects completed work to be committed to version control rather than left as a large uncommitted working tree; will explicitly ask for a commit once a body of work is done. Confidence: 0.6
- Prefers the agent to keep progressing on the buildable scope (e.g. via fakes/stubs backed by real tests) rather than halting at a blocker that needs unavailable external resources, recording the blocked items honestly for later. Confidence: 0.6
