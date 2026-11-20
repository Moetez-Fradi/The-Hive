# What's new in AgentHive 2026

AgentHive placed 2nd at last year's Dar Blockchain hackathon. This is the same idea, rebuilt where it was weakest. Everything below was audited against the 2025 code and changed in this repository.

## 1. Verifiable execution on Hedera Consensus Service

**2025:** a workflow returned whatever the runner said. Nothing recorded what ran, on which input, or what came out.

**2026:** every run is hashed (input, per-step outputs, and the node assignment) with canonical JSON and SHA-256. The run hash is submitted to an HCS topic that only the platform can write to.

- `GET /runs/:id/verify` recomputes the hashes from the stored run and compares them with the message read back from the Hedera mirror node.
- If one stored output changes, the check fails.
- Each run in the UI has a "Verify on Hedera" button and a HashScan link.
- Verified deployment payments are anchored to the same topic, so the audit trail covers both money and compute.

## 2. Payments that are actually verified, and enforced

**2025:**
- Legacy HashConnect, which HashPack has since shut down.
- The backend marked a payment as paid without checking the ledger.
- A deployed workflow URL could be called by anyone, paid or not.

**2026:**
- Wallets connect through HashConnect 3 and WalletConnect.
- Payments are verified on the mirror node:
  - the transaction must succeed,
  - the payer must match the linked wallet,
  - every receiver must get at least their share,
  - the memo must be unique to this deployment,
  - and a transaction ID can't be reused to unlock a second deployment.
- Runs go through `POST /workflows/:id/run`, which returns `402 Payment Required` until the deployment payment is verified.
- The execution server rejects any call without the shared runner key.

## 3. Node operators get paid, and reputation means something

**2025:** renters ran containers for free, and the `reputation` column was never written.

**2026:**
- In decentralized mode, the deployment receipt includes a compute fee (`NODE_COMPUTE_FEE_HBAR`) for each node operator with a linked wallet.
- After every run, each node's reputation is updated as an exponential moving average of its success rate.
- Nodes are chosen by reputation first, then freshness.
- Nodes that stop sending heartbeats are marked offline after 3 minutes.

## 4. AI that builds the workflow for you

**2025:** workflows were wired by hand, and the sample LLM tools used OpenRouter or an unofficial Google Translate scraper.

**2026:**
- `POST /ai/compose` sends the tool marketplace catalog and a plain-language request to Gemini Flash Lite. It uses schema-constrained output and gets back a workflow graph: which tools, in what order, field mappings, conditions and config values.
- The result is validated against real tool IDs before it reaches the React Flow canvas.
- Secret config keys are never filled in by the model.
- The translator and classifier tools now run on Gemini Flash Lite with JSON schemas. The classifier returns a confidence score and a reason, and the translator reports the detected source language.

## 5. Security fixes

| Issue in 2025 | Fix |
|---|---|
| Edge conditions ran through `new Function` and `with` on the execution server, so any workflow author could run code on the host | A small expression parser that only supports comparisons, `&&`, `||`, `!`, literals and field paths |
| The frontend `eval`'d tool `inputShape` strings in the browser | Removed; shapes are parsed as JSON only |
| Tool secrets (API keys) were stored in plain text in workflow graphs and returned by public endpoints | Encrypted at rest with AES-256-GCM, and only key names are ever returned |
| `GET /workflows/:id` returned the owner's bcrypt password hash | The owner is reduced to id, display name and wallet |
| `GET /workflow-instances` had no auth guard and listed every user's instances with their secrets | All instance routes need a JWT and ownership |
| Anyone could start containers on the execution server | Runner key required on every POST |
| Renter nodes accepted any `/start-container` call; the one-time token was generated but never checked | The node redeems the token with the backend before starting anything; tokens are single use, bound to that node and its owner, and expire |

## 6. Correctness fixes

- **Inputs for later steps:** in the old executor, a step's input overrode its output when building the next step's input, so downstream tools received the original text instead of the processed result. A translate-then-classify chain was classifying the untranslated message.
- **Deploy tests:** a test case read upstream results from the wrong map, so steps after the first never received input during deploy tests.
- **Shared executor:** three copy-pasted orchestration loops in the runner are now one executor. It rejects cyclic graphs and only forwards successful steps.
- **Self-healing deployments:** when the runner restarts and loses a deployed workflow, the next run redeploys it from the stored, encrypted graph and retries, so the user never notices.
- **Clock skew:** if the host clock drifts, Hedera transactions now use network time from the mirror node instead of failing with `TRANSACTION_EXPIRED`.
- **Smaller fixes:**
  - `GET /workflows/search` was shadowed by `GET /workflows/:id` and never ran.
  - Search is now case-insensitive.
  - Tool usage counts are updated after each run.
  - Estimated cost is computed from real tool prices.

## 7. Live on Hedera Testnet

A full run of the new flow, recorded on testnet:

| Step | Proof |
|---|---|
| Audit topic (payments and runs) | [0.0.11532808](https://hashscan.io/testnet/topic/0.0.11532808) |
| Deployment payment, 1.5 HBAR to the tool owner | [transaction](https://hashscan.io/testnet/transaction/0.0.11529815-1795132203-862249929) |
| Payment receipt anchored after mirror-node verification | [message #2](https://hashscan.io/testnet/topic/0.0.11532808/message/2) |
| Workflow run (Spanish bug report, translated then classified) | [message #3](https://hashscan.io/testnet/topic/0.0.11532808/message/3) |

Before the payment was verified, the run endpoint returned `402`. After it, the run went through and `GET /runs/:id/verify` matched all three hashes against the mirror node.

## 8. Reproducible setup

- Prisma schema push and an idempotent seeder (`pnpm db:push`, `pnpm db:seed`) with demo users, tools, workflows and reviews. Secrets in the seed come from environment variables.
- `HOW-TO-RUN.md` covers the whole local setup against Hedera Testnet.
