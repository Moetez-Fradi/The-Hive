# How to Run Your Own AgentHive

Run the backend, frontend, execution server and decentralized nodes locally against Hedera Testnet.

## 1. Prerequisites

- Node.js 20+ and pnpm (`corepack enable`)
- Docker Desktop, running
- A Supabase (or any Postgres) database
- A Hedera Testnet account from [portal.hedera.com](https://portal.hedera.com)
- A WalletConnect project id from [dashboard.reown.com](https://dashboard.reown.com)
- HashPack, switched to Testnet

```bash
git clone https://github.com/Moetez-Fradi/The-Hive.git
cd The-Hive
```

## 2. Environment

| File | Keys |
|---|---|
| `backend/.env` | `DIRECT_URL`, `DATABASE_URL`, `OPERATOR_ID`, `OPERATOR_KEY`, `JWT_SECRET`, `SERVER_SECRET_KEY`, `GRAPH_ENCRYPTION_KEY`, `RUNNER_TOKEN`, `GEMINI_API_KEY`, runner URLs (see `.env.local`). Optional: `GEMINI_MODEL` (default `gemini-flash-lite-latest`), `HCS_TOPIC_ID`, `NODE_COMPUTE_FEE_HBAR` (default 0.1) |
| `decentralizer/.env` | `SERVER_SECRET_KEY` and `RUNNER_TOKEN` (same values as the backend) |
| `renter/.env` | `BACKEND_URL`, `NODE_FILE`, `NODE_PORT`, optional `USE_TUNNEL=true` |
| `frontend/.env` | `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` |

`SERVER_SECRET_KEY` is 32 random bytes in base64, `GRAPH_ENCRYPTION_KEY` is a 32 character string and `RUNNER_TOKEN` is any long random string:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

`GEMINI_API_KEY` comes from [Google AI Studio](https://aistudio.google.com/apikey). The backend uses it for the AI workflow composer, and the seeder injects it into the translator and classifier tools through `${GEMINI_API_KEY}` placeholders in `seed-data.json`.

The HCS audit topic is created automatically on the first run and stored in the `Setting` table. Set `HCS_TOPIC_ID` to reuse an existing topic.

## 3. Database

```bash
cd backend
pnpm install
pnpm db:push
cp prisma/seed-data.example.json prisma/seed-data.json   # edit names, wallets and passwords
pnpm db:seed
```

## 4. Sample tools

Tools are Docker images that expose `POST /run` on port 80. Build the samples locally:

```bash
docker build -t agenthive/text-translator sampleTools/textTranslator
docker build -t agenthive/text-classifier sampleTools/textclassifier
docker build -t agenthive/emailer sampleTools/emailer
```

Images that exist locally are used as is; anything else is pulled from its registry.

## 5. Start the services

```bash
cd backend && pnpm start:dev           # http://localhost:3001
cd decentralizer && node server.js     # http://localhost:3111
cd frontend && npm install && npm run dev   # http://localhost:3000
```

## 6. Run decentralized nodes

Each node hosts one tool of a workflow. When fewer nodes are online than the workflow has tools, the backend falls back to the execution server.

```bash
cd renter
pnpm install
node renter-node.js
```

For more nodes, give each its own key file and port:

```bash
NODE_FILE=./node_keys1.json NODE_PORT=9001 node renter-node.js
```

`NODE_EMAIL`, `NODE_PASSWORD`, `NODE_CPUS` and `NODE_MEM_GB` skip the interactive prompts. Set `USE_TUNNEL=true` to expose the node through localtunnel instead of localhost.

## 7. Payments

Deploying a workflow creates a receipt that pays each tool owner in HBAR, plus a compute fee for each renter node in decentralized mode. The payment is signed in HashPack through WalletConnect, and the backend verifies it on the Hedera mirror node (result, payer, amounts and memo) before marking it paid. The verified payment is anchored on the HCS audit topic.

## 8. Runs and proofs

A workflow runs through `POST /workflows/:id/run`, which returns `402` until the deployment payment is verified. Each run is hashed and anchored on the HCS audit topic:

```bash
curl -X POST localhost:3001/workflows/<id>/run -H "Authorization: Bearer <jwt>" -H "Content-Type: application/json" -d '{"input":{"text":"Bonjour"}}'
curl localhost:3001/runs/<runId>/verify
```

`verify` recomputes the hashes from the stored run and compares them with the message read back from the mirror node.

## 9. AI composer

`POST /ai/compose` with `{"prompt": "..."}` returns a workflow graph built from the tools in the marketplace. The builder page has a "Compose with AI" box that loads the result into the canvas.
