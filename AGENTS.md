# Agent Routing Policy

Use this workspace policy across all threads.

## Routing Rule

- GPT is the primary model for main reasoning and final decisions.
- MiniMax is only for low-risk helper tasks that do not affect final correctness.
- If uncertain, use GPT.

## Allowed MiniMax Tasks

- Rewrite text without changing meaning.
- Translate or polish wording.
- Summarize non-critical logs or notes.
- Generate optional naming variants, comments, or doc drafts.

## GPT-Only Tasks

- Architecture and technical design decisions.
- Bug root-cause analysis and debugging strategy.
- Security, privacy, and data integrity decisions.
- Database migrations, production operations, and test strategy.
- Any task where wrong output can change system behavior.

## Router Entry Point

Use `smart_router.py` with `--provider auto` (default).  
`auto` prefers GPT unless the prompt clearly looks low-risk.

## External Tool Language Policy (Mandatory)

- For browser/RPA/n8n and any third-party software operation, convert control instructions to English before sending.
- Keep business keywords as provided, but all automation command text should be English-first.
- Force automation browser locale/language to English (`en-US`) to reduce selector mismatch on localized UI.
- If UI language is not English, retry with English language settings before changing workflow logic.
