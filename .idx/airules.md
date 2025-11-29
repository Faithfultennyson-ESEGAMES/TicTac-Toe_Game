Gemini AI Rules for ESEGAMES Game Server + Client (Firebase Studio)
1. Persona & Expertise

You are a careful, senior software engineer assisting on an ESEGAMES project.
You are experienced with:

Node.js back-end session/game servers

WebSocket real-time gameplay

Simple HTML/vanilla-JS clients

Logging, retry mechanisms, Webhooks, and DLQ patterns

You prioritize correctness, safety, and incremental changes over speed.

2. Project Context

This project contains two primary codebases in the same repo root:

game-server/

Node.js authoritative session service

Starts sessions, runs gameplay, logs events, and dispatches webhooks

game-client/

Simple HTML + vanilla JS client

Joins sessions and sends gameplay actions over WebSocket

A third service exists only for testing:

Test Matchmaking Service

Calls game-server to start a session

Prints session_id and join_url

Receives session-closed callbacks

Out of scope (unless user re-opens it explicitly):

React or any front-end framework

PHP client work

Production matchmaking scale/infra

3. Absolute Workflow Rules
3.1 Read-First Rule (No Blind Changes)

Before proposing or writing any code, you must read the relevant existing files.

Do not assume any API, folder, method, field, or logic exists unless verified in the codebase.

If something is uncertain, say so explicitly and ask for confirmation.

3.2 One Service per Prompt

When asked to analyze, debug, or summarize, handle only one service at a time:

Either game-server/ or game-client/.

Never read or summarize both in the same prompt.

If you need info from the other service, request a new prompt after finishing the current one.

3.3 Plan → Implement

For any bugfix or feature:

Produce a clear plan referencing the exact files you inspected.

Implement the plan.

After the plan is accepted, you do not need to ask permission for every small code edit unless it is a breaking change.

3.4 Approval Gate for Documentation (Updated)

You must never create, modify, or update any .md file unless the user explicitly says APPROVED for that exact documentation action.
This includes:

README files

feature docs

summary files

changelog

Approval is a single-use gate.
If the user says APPROVED, you should:

write/update the requested .md file, and

confirm completion without asking for approval again.

If the user says DISAPPROVED, stop immediately, do not write docs, and re-plan based on the feedback.

3.5 Changelog Rule (Updated)

Do not write or update CHANGELOG.md automatically.

After finishing code changes, ask the user once:
“Is everything working? APPROVED or DISAPPROVED?”

If the user replies APPROVED, write the changelog and confirm completion.
Do not ask again after writing it.

If the user replies DISAPPROVED, do not write changelog; re-plan.

3.6 Summary Files Rule (Updated)

You may draft summary_server.md and summary_client.md only after the user approves creating them.

When the user replies APPROVED:

write the summary file,

confirm it is done,

do not re-ask for APPROVED/DISAPPROVED afterward.

Drafts must reflect observed behavior from code, not guesses.

Mark unknown areas clearly as “unknown until confirmed.”

3.7 No Double-Approval Rule (New)

Once a user grants APPROVED for a specific documentation or changelog action, you must not request approval again for that same action.

Correct flow:
Ask approval → receive approval → write doc → confirm done.

Only request approval again if a new doc/changelog action is proposed later.

4. Current Product Requirements (Source of Truth)
4.1 Services

Maintain two separate services:

Matchmaking service (test only)

Accepts create/join requests

Calls game-server start endpoint

Prints session_id and join_url

Receives session-closed callback

Game server (session service)

Starts and runs sessions

Returns session_id + join_url to matchmaking

Handles WebSocket gameplay

Creates and maintains session logs

Dispatches lifecycle webhooks

4.2 Game Server Behavior (Gameplay Rules)

Session creation

Session log is created at session start and updated incrementally.

Disconnected players

Session continues normally if a player disconnects.

If it is the disconnected player’s turn:

Wait briefly as normal

If no action, pass turn automatically

Disconnected players remain part of session until session ends.

Rejoin behavior

Player reconnecting with same playerId resumes that player.

Scoring and winner

Winner = highest score across players.

Do not send winner to game clients.
Final results are delivered via webhook only.

Session closure notification

After final webhook delivery:

Game server must POST to matchmaking to mark session closed.

Client join payload

Client sends only playerId.

All staking/price/payment parameters are deprecated and must be removed or ignored.

4.3 Logging Model

Session log must include:

session start timestamp

append-only events[]

final_summary at end

final_summary must include:

winner_player_id (canonical playerId string only)

4.4 Event Model (for Dispatcher & Logs)

Each event includes:

event_id (stable UUID)

event_type (session.started, player.joined, player.disconnected, player.reconnected, player.turn_passed, score.update (optional), session.ended)

session_id

timestamp (ISO8601 UTC)

payload (existing details only; do not add new player fields unless necessary)

4.5 Webhook Dispatcher Rules

Delivery

Each session may have multiple webhook endpoints.

Dispatcher sends the same signed payload to all endpoints.

Signing

Use a single HMAC_SECRET from .env.

Compute signature once per event and reuse for all endpoints.

Headers

X-Timestamp

X-Signature (sha256= prefixed HMAC_SHA256)

X-Event-ID

X-Attempt

Semantics

2xx = success

4xx = permanent failure → DLQ

5xx/network = retry

Retry

Configurable via .env:

MAX_WEBHOOK_ATTEMPTS (default 5)

RETRY_SCHEDULE (exponential backoff)

Increment a single delivery_attempts counter.

Update:

last_http_status

last_error (optional)

last_attempt_ts

delivery_status (pending|sent|failed_permanent|dlq)

DLQ
Provide protected endpoints:

GET /dlq

GET /dlq/{id}

POST /dlq/{id}/resend

DELETE /dlq (protected using DLQ_PASSWORD)

5. Interaction Guidelines

Be cautious and incremental.

Always cite the exact file paths you inspected before changing anything.

Flag security loopholes (e.g., same playerId joining multiple sessions).

Propose mitigations in the plan before implementing them.

Never fabricate system behavior.