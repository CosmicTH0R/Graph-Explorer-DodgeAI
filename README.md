# LLM-Powered Graph Explorer

> **Live Demo:** [https://graph-explorer-dodge-ai.vercel.app/](https://graph-explorer-dodge-ai.vercel.app/)

A full-stack application for exploring SAP supply chain data using natural language. Ask plain-English questions, get LLM-generated Cypher queries executed against Neo4j AuraDB, and watch the results rendered as an interactive force-directed graph — all in real time.

---

## Table of Contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Graph Data Model](#graph-data-model)
4. [LLM Pipeline](#llm-pipeline)
5. [Security](#security)
6. [Project Structure](#project-structure)
7. [Environment Variables](#environment-variables)
8. [Local Development](#local-development)
9. [ETL Setup](#etl-setup)
10. [API Reference](#api-reference)
11. [Deployment](#deployment)

---

## Features

- **Natural language to Cypher** — Ask questions like *"Which products appear in the most billing documents?"* and get an LLM-generated Cypher query executed live.
- **Streaming responses** — Answers stream token-by-token via Server-Sent Events (SSE) using `generateContentStream()` for a real-time feel.
- **Interactive graph visualization** — Results rendered with `react-force-graph-2d`; nodes are color-coded by label.
- **Node expansion** — Right-click any node to fetch and merge its neighbors from Neo4j without resetting the graph.
- **Node inspection** — Click any node to see all its properties in a floating panel.
- **Highlighted references** — Nodes mentioned in the LLM answer are automatically outlined in yellow on the graph.
- **Conversation memory** — Last 10 messages are sent as context so follow-up questions resolve correctly.
- **Guardrail** — Off-topic queries are blocked before any Cypher is generated.
- **Read-only enforcement** — Regex word-boundary checks block any mutating Cypher (`CREATE`, `DELETE`, `SET`, etc.).
- **30-second query timeout** — Runaway Neo4j queries are automatically cancelled.
- **7 node types fully colored** — Customer, SalesOrder, DeliveryDocument, BillingDocument, JournalEntry, Product, Address.

---

## Architecture

```
┌─────────────────────────────────┐
│        Browser (Next.js)        │
│  ChatSidebar  │  GraphCanvas    │
│  NodeInspector│  Legend         │
└──────────┬──────────────────────┘
           │ POST /api/chat (SSE)
           │ POST /api/expand
┌──────────▼──────────────────────┐
│      Next.js API Routes         │
│  1. Guardrail (Gemini)          │
│  2. Text-to-Cypher (Gemini)     │
│  3. Read-only validation        │
│  4. Neo4j execution (30s limit) │
│  5. Streaming summarization     │
│     (Gemini generateContentStream) │
└──────────┬──────────────────────┘
           │ Bolt / neo4j+s
┌──────────▼──────────────────────┐
│        Neo4j AuraDB             │
│  7 node types · 11 rel types    │
└─────────────────────────────────┘
```

**Tech stack:**

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16 (React 19), Tailwind CSS v4 |
| Graph rendering | react-force-graph-2d |
| Backend | Next.js API Routes (Edge-compatible) |
| LLM | Gemini 2.5 Flash (`@google/generative-ai`) |
| Database | Neo4j AuraDB (neo4j-driver v6) |
| Deployment | Vercel |

---

## Graph Data Model

### Node Labels

| Label | Key Properties |
|-------|---------------|
| `Customer` | `id` |
| `SalesOrder` | `id`, `totalNetAmount`, `overallDeliveryStatus`, `soldToParty`, `creationDate` |
| `DeliveryDocument` | `id`, `overallGoodsMovementStatus`, `shippingPoint` |
| `BillingDocument` | `id`, `totalNetAmount`, `billingDocumentType`, `billingDocumentDate`, `soldToParty`, `accountingDocument` |
| `JournalEntry` | `id`, `accountingDocumentType`, `postingDate`, `glAccount`, `amountInTransactionCurrency` |
| `Product` | `id` (material number) |
| `Address` | `id`, `type` (Plant/ShippingPoint/Location), `code`, `name` |

### Relationships

```
(Customer)         -[:PLACES]->         (SalesOrder)
(Customer)         -[:BILLED_TO]->      (BillingDocument)
(SalesOrder)       -[:GENERATES]->      (DeliveryDocument)
(SalesOrder)       -[:CONTAINS_ITEM]->  (Product)
(SalesOrder)       -[:DELIVERS_TO]->    (Address)
(SalesOrder)       -[:SOURCED_FROM]->   (Address)
(DeliveryDocument) -[:BILLED_IN]->      (BillingDocument)
(DeliveryDocument) -[:SHIPPED_FROM]->   (Address)
(DeliveryDocument) -[:LOCATED_AT]->     (Address)
(BillingDocument)  -[:CONTAINS_ITEM]->  (Product)
(BillingDocument)  -[:ACCOUNTED_IN]->   (JournalEntry)
```

**Stats:** ~20,309 Product nodes, 14 Address nodes, 137 GENERATES edges, 245 BILLED_IN edges, 490 Address edges.

---

## LLM Pipeline

Every user message goes through a three-stage pipeline in `src/app/api/chat/route.ts`:

### Stage 1 — Guardrail
```
Temperature: 0  |  Model: gemini-2.5-flash
```
User input is wrapped in `<user_input>…</user_input>` delimiters (prompt injection protection) and sent to Gemini with the question: *"Is this query related to business supply chain, orders, billing, or the provided dataset? Answer YES or NO."*

- Response must be exactly `"YES"` (strict equality) — anything else blocks the query.

### Stage 2 — Text-to-Cypher
```
Temperature: 0  |  Model: gemini-2.5-flash
```
The full DB schema + last 10 messages of conversation history are injected into the system prompt. Gemini returns a raw Cypher query. Before execution, a regex word-boundary check rejects any query containing `CREATE`, `DELETE`, `MERGE`, `SET`, `REMOVE`, `DROP`, `DETACH`, `FOREACH`, `LOAD CSV`, or `CALL APOC`.

### Stage 3 — Streaming Summarization
```
Temperature: 0.2  |  Model: gemini-2.5-flash  |  generateContentStream()
```
Raw Neo4j results (JSON) are passed to Gemini for natural-language summarization. The response streams back to the browser via SSE with three event types:

| Event | Payload | Purpose |
|-------|---------|---------|
| `meta` | `{ nodes, links, rawQuery }` | Graph data + Cypher query |
| `token` | `"string chunk"` | Progressive text token |
| `done` | `{ highlightedIds: string[] }` | Node IDs to highlight |

---

## Security

| Concern | Mitigation |
|---------|-----------|
| Prompt injection | User input wrapped in `<user_input>` XML delimiters |
| Guardrail bypass | Strict `!== 'YES'` equality check (not `.includes()`) |
| Write operations | Regex word-boundary patterns (`\bSET\b`, `\bDROP\b`, etc.) |
| Highlight false positives | Word-boundary regex prevents ID "123" matching "2123 units" |
| Query hangs | 30-second timeout on all `session.run()` calls |
| Label injection in expand | Allowlist of 7 known labels validated server-side |
| SSE memory leaks | `AbortController` cancelled on component unmount |

---

## Project Structure

```
graph-explorer/
├── etl/
│   ├── ingest.py              # Main ETL — nodes + relationships from JSONL
│   └── ingest_addresses.py    # Address node ETL (Plant, ShippingPoint, Location)
├── data/                      # Raw JSONL source files (49 files)
├── src/
│   ├── app/
│   │   ├── page.tsx           # Main orchestrator (~180 lines, state + handlers)
│   │   ├── layout.tsx
│   │   └── api/
│   │       ├── chat/
│   │       │   └── route.ts   # 3-stage LLM pipeline + SSE streaming
│   │       └── expand/
│   │           └── route.ts   # Neighbor expansion API
│   ├── components/
│   │   ├── types.ts           # Shared interfaces + LABEL_COLOURS map
│   │   ├── ChatSidebar.tsx    # Chat UI (messages, input, streaming cursor)
│   │   ├── GraphCanvas.tsx    # Force-directed graph (react-force-graph-2d)
│   │   ├── Legend.tsx         # Dynamic color legend
│   │   └── NodeInspector.tsx  # Floating node property panel
│   └── lib/
│       └── neo4j.ts           # Neo4j driver singleton
├── .env                       # Local secrets (not committed)
├── package.json
├── tsconfig.json
└── README.md
```

---

## Environment Variables

Create a `.env` file in the project root:

```env
GEMINI_API_KEY=your_gemini_api_key_here
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_neo4j_password_here
```

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google AI Studio API key — [get one here](https://aistudio.google.com/app/apikey) |
| `NEO4J_URI` | AuraDB Bolt URI from your Neo4j console (`neo4j+s://…`) |
| `NEO4J_USERNAME` | AuraDB username (default: `neo4j`) |
| `NEO4J_PASSWORD` | AuraDB password set at instance creation |

> **Important:** Never commit `.env` to version control. It is listed in `.gitignore`.

---

## Local Development

**Prerequisites:** Node.js 18+, npm 9+

```bash
# 1. Clone and install
git clone <your-repo-url>
cd graph-explorer
npm install

# 2. Set up environment
cp .env.example .env   # then fill in your keys

# 3. Run the dev server
npm run dev
# App available at http://localhost:3000

# Other scripts
npm run build    # production build
npm run start    # serve production build
npm run lint     # ESLint check
```

---

## ETL Setup

**Prerequisites:** Python 3.9+

```bash
# 1. Create a virtual environment
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS/Linux

# 2. Install dependencies
pip install pandas neo4j python-dotenv

# 3. Ensure .env exists with Neo4j credentials (see above)

# 4. Run the main ETL (nodes + relationships)
python etl/ingest.py
# Parses 49 JSONL files → ~1,398 entity nodes + 20,309 Product nodes
# Creates all relationship types

# 5. Run the Address ETL
python etl/ingest_addresses.py
# Creates 14 Address nodes + 490 address-related edges
```

The ETL scripts are idempotent — they use `MERGE` with unique constraints to prevent duplicate nodes on re-runs.

---

## API Reference

### `POST /api/chat`

Runs the full LLM pipeline and streams the response.

**Request body:**
```json
{
  "message": "Which customers have the most sales orders?",
  "history": [
    { "role": "user", "text": "Show me all customers" },
    { "role": "assistant", "text": "Found 12 customers..." }
  ]
}
```

**Response:** `Content-Type: text/event-stream`

```
event: meta
data: {"nodes":[...],"links":[...],"rawQuery":"MATCH (c:Customer)..."}

event: token
data: "There are 12 customers"

event: token
data: " in the dataset..."

event: done
data: {"highlightedIds":["42","17"]}
```

**Error response (JSON, non-streaming):**
```json
{ "reply": "This system is designed to answer questions related to the provided dataset only." }
```

---

### `POST /api/expand`

Fetches all direct neighbors of a given node.

**Request body:**
```json
{
  "nodeId": "123",
  "label": "SalesOrder"
}
```

**Response:**
```json
{
  "nodes": [
    { "id": "123", "label": "SalesOrder", "properties": { "id": "740571", ... } },
    { "id": "456", "label": "Customer",   "properties": { "id": "320000083" } }
  ],
  "links": [
    { "source": "456", "target": "123", "type": "PLACES" }
  ]
}
```

- Returns up to 50 neighbors (`LIMIT 50`).
- `label` is validated against an allowlist of 7 known types; unknown labels return `400`.

---

## Deployment

The app is deployed on **Vercel** with automatic builds on `git push`.

**Live URL:** [https://graph-explorer-dodge-ai.vercel.app/](https://graph-explorer-dodge-ai.vercel.app/)

Set the same four environment variables (`GEMINI_API_KEY`, `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`) in your Vercel project settings under **Settings → Environment Variables**.

---

## Acknowledgments

Built for the Forward Deployed Engineer (FDE) assignment.
Powered by **Neo4j AuraDB**, **Gemini 2.5 Flash**, **Next.js 16**, **React 19**, and **Tailwind CSS v4**.
