# LLM-Powered Graph Explorer

> **Live Demo:** [https://graph-explorer-dodge-ai.vercel.app/](https://graph-explorer-dodge-ai.vercel.app/)

A full-stack application for exploring SAP supply chain data using natural language. Ask plain-English questions, get LLM-generated Cypher queries executed live against Neo4j AuraDB, and watch results rendered as an interactive force-directed graph in real time.

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
11. [Testing](#testing)
12. [Stress-Tested Queries](#stress-tested-queries)
13. [Deployment](#deployment)

---

## Features

- **Natural language to Cypher** - Ask *"Which products appear in the most billing documents?"* and receive a live-executed Cypher query with results.
- **Streaming responses** - Answers stream token-by-token via Server-Sent Events using `generateContentStream()` for a real-time feel.
- **Pre-loaded overview graph** - On page load, all non-Product nodes and their relationships are fetched automatically so the canvas is never blank.
- **Interactive graph visualization** - Results rendered with `react-force-graph-2d`; nodes color-coded by label with a dynamic legend.
- **Zoom-to-node** - Left-clicking a node centers and zooms to it (6x zoom, 600 ms animation).
- **Node expansion** - Right-click any node to fetch and merge its direct neighbors from Neo4j without resetting the graph.
- **Node inspection** - Click any node to view all its properties in a scrollable floating panel.
- **Highlighted references** - Entity IDs mentioned in the LLM answer are automatically outlined in yellow on the graph.
- **Markdown rendering** - LLM answers render with full Markdown (bold, lists, headings) via `react-markdown`.
- **Conversation memory** - Last 10 messages sent as context so follow-up questions resolve correctly (e.g. *"what about that customer?"*).
- **Guardrail** - Off-topic queries blocked before any Cypher is generated.
- **Read-only enforcement** - Regex word-boundary checks block all mutating Cypher keywords.
- **30-second query timeout** - Runaway Neo4j queries cancelled automatically.

---

## Architecture

```
+------------------------------------------+
|            Browser (Next.js)             |
|  ChatSidebar  |  GraphCanvas             |
|  NodeInspector|  Legend                  |
+------------------------------------------+
           | SSE  POST /api/chat
           |      POST /api/expand
           |      GET  /api/overview
+----------+-------------------------------+
|         Next.js API Routes               |
|                                          |
|  +- /api/chat -----------------------+   |
|  | 1. Guardrail          (Gemini)    |   |
|  | 2. Text-to-Cypher     (Gemini)    |   |
|  | 3. Read-only check    (regex)     |   |
|  | 4. Neo4j execution    (30s max)   |   |
|  | 5. Streaming summary  (Gemini)    |   |
|  +-----------------------------------+   |
|  /api/overview  -> initial graph load    |
|  /api/expand    -> neighbor fetch        |
+------------------------------------------+
           | Bolt (neo4j+s://)
+----------+-------------------------------+
|            Neo4j AuraDB                  |
|   7 node types | 11 relationship types   |
+------------------------------------------+
```

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16 (React 19), Tailwind CSS v4 |
| Graph rendering | react-force-graph-2d 1.29 |
| Markdown rendering | react-markdown |
| Backend | Next.js API Routes |
| LLM | Gemini 2.5 Flash (`@google/generative-ai`) |
| Database | Neo4j AuraDB (neo4j-driver v6) |
| Testing | Jest + ts-jest (37 unit tests) |
| Deployment | Vercel |

---

## Graph Data Model

### Node Labels

| Label | Key Properties |
|-------|----------------|
| `Customer` | `id` |
| `SalesOrder` | `id`, `totalNetAmount`, `overallDeliveryStatus`, `soldToParty`, `creationDate` |
| `DeliveryDocument` | `id`, `overallGoodsMovementStatus`, `shippingPoint` |
| `BillingDocument` | `id`, `totalNetAmount`, `billingDocumentType`, `billingDocumentDate`, `soldToParty`, `accountingDocument` |
| `JournalEntry` | `id`, `accountingDocumentType`, `postingDate`, `glAccount`, `amountInTransactionCurrency` |
| `Product` | `id` (material number) |
| `Address` | `id`, `type` (Plant / ShippingPoint / Location), `code`, `name` |

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

**Database stats:** ~20,309 Product nodes | 14 Address nodes | 137 GENERATES edges | 245 BILLED_IN edges | 490 Address edges.

---

## LLM Pipeline

Every user message passes through a four-stage pipeline in `src/app/api/chat/route.ts`.

### Stage 1 - Guardrail

```
Model: gemini-2.5-flash    Temperature: 0
```

User input is wrapped in `<user_input>...</user_input>` XML delimiters (prompt injection protection) and sent to Gemini with the instruction to return only `YES` or `NO`.

- Strict equality check: `guardrailResponse !== 'YES'` — any deviation blocks the query.
- On block: returns `"This system is designed to answer questions related to the provided dataset only."`

### Stage 2 - Text-to-Cypher

```
Model: gemini-2.5-flash    Temperature: 0
```

- Full DB schema (7 labels, 11 relationships, key property names) injected into the prompt.
- Last 10 messages of conversation history included for follow-up resolution.
- Curated pattern hints for common queries (flow tracing, ranking by count, gap analysis).
- **CRITICAL rule enforced in prompt:** always return relationship variables (e.g. `-[r1:GENERATES]->`) so the frontend graph can render edges.

### Stage 2.5 - Read-Only Enforcement

Regex word-boundary patterns applied to the generated Cypher before execution:

```ts
/\bCREATE\b/, /\bDELETE\b/, /\bMERGE\b/, /\bSET\b/, /\bREMOVE\b/,
/\bDROP\b/, /\bDETACH\b/, /\bFOREACH\b/, /CALL\s+APOC/, /LOAD\s+CSV/, /CALL\s*\{/
```

Word-boundary matching prevents bypasses via `SET\n`, `RESET`, `OFFSET`, or subquery injection (`CALL {}`).

### Stage 3 - Neo4j Execution

- Query executed with a 30-second timeout.
- Result records parsed for three value types:
  - **Neo4j Node** - extracted to `{ id, label, properties }`
  - **Relationship** - stored as `{ source, target, type }`
  - **Path** - segments unpacked into nodes + edges
- Results compacted with depth-aware `compactRecord()`: top-level property maps preserved in full; nested objects/arrays replaced with `[object]` / `[array:N]` to save prompt tokens.

### Stage 4 - Streaming Summarization

```
Model: gemini-2.5-flash    Temperature: 0.2    generateContentStream()
```

Compacted results (up to 12,000 chars) passed to Gemini for natural-language summarization. Response streams back via SSE:

| SSE Event | Payload | Purpose |
|-----------|---------|---------|
| `meta` | `{ nodes, links, rawQuery }` | Graph data + raw Cypher sent first |
| `token` | `"text chunk"` | Progressive answer tokens |
| `done` | `{ highlightedIds: string[] }` | Node IDs to highlight on graph |

Highlighted IDs are computed by matching every node's identifier-like properties (`id`, `code`, `name`, `*Id`, `*Code`, `*Document`, strong uppercase strings) against the full LLM answer using word-boundary regex.

---

## Security

| Concern | Mitigation |
|---------|------------|
| Prompt injection | `<user_input>` XML delimiters isolate user content from system instructions |
| Guardrail bypass | `guardrailResponse !== 'YES'` strict equality (not `.includes()`) |
| Write operations | 11 regex word-boundary patterns covering all mutation keywords + `CALL {}` subqueries |
| False-positive highlights | `escapeRegExp()` + `\b...\b` prevents ID "123" matching "2123 units" |
| Query hangs | 30-second timeout on every `session.run()` call |
| Label injection | Expand endpoint validates `label` against allowlist of 7 known types |
| SSE memory leaks | `AbortController` cancelled on component unmount via `useEffect` cleanup |

---

## Project Structure

```
graph-explorer/
├── jest.config.js               # Jest configuration (ts-jest preset)
├── next-env.d.ts
├── package.json
├── postcss.config.js
├── tailwind.config.js
├── tsconfig.json
├── etl/                         # Python ETL scripts (JSONL -> Neo4j)
├── data/                        # Raw JSONL source files
└── src/
    ├── app/
    │   ├── globals.css
    │   ├── layout.tsx
    │   ├── page.tsx
    │   └── api/
    │       ├── chat/
    │       │   └── route.ts     # 4-stage LLM pipeline + SSE streaming
    │       ├── expand/
    │       │   └── route.ts     # Neighbor expansion endpoint
    │       └── overview/
    │           └── route.ts     # Initial graph load
    ├── components/
    │   ├── ChatSidebar.tsx      # Chat UI with SSE consumer
    │   ├── GraphCanvas.tsx      # react-force-graph-2d canvas
    │   ├── Legend.tsx           # Dynamic color legend
    │   ├── NodeInspector.tsx    # Floating property panel
    │   └── types.ts             # Shared frontend types
    ├── lib/
    │   ├── neo4j.ts             # Neo4j driver singleton
    │   └── pipeline-utils.ts   # Testable pure utility functions
    └── __tests__/
        └── pipeline-utils.test.ts  # 37 unit tests
```

---

## Environment Variables

Create a `.env.local` file in the project root:

```env
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-password-here
GEMINI_API_KEY=your-gemini-api-key-here
```

All four variables are required. The app will not start without them.

---

## Local Development

```bash
# Install dependencies
npm install

# Start the dev server
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Type-check
npx tsc --noEmit
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## ETL Setup

The `etl/` directory contains Python scripts to load the raw JSONL files from `data/` into Neo4j AuraDB.

```bash
cd etl
pip install -r requirements.txt
python load.py
```

The loader creates all nodes and relationships using `MERGE` to avoid duplicates. Run time is approximately 5-10 minutes for the full dataset.

---

## API Reference

### `POST /api/chat`

Runs the full 4-stage LLM pipeline and streams the response.

**Request body:**
```json
{
  "message": "Which customers have the most sales orders?",
  "history": [{ "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }]
}
```

**Response:** `text/event-stream` (SSE)

```
event: meta
data: { "nodes": [...], "links": [...], "rawQuery": "MATCH ..." }

event: token
data: "The top customer is"

event: token
data: " C1001 with 42 orders."

event: done
data: { "highlightedIds": ["C1001"] }
```

---

### `GET /api/overview`

Returns all non-Product nodes and their relationships for the initial graph render.

**Response:** `200 OK`
```json
{ "nodes": [...], "links": [...] }
```

---

### `POST /api/expand`

Fetches the direct neighbors of a specific node.

**Request body:**
```json
{ "nodeId": "SO-001", "label": "SalesOrder" }
```

**Response:** `200 OK`
```json
{ "nodes": [...], "links": [...] }
```

`label` must be one of: `Customer`, `SalesOrder`, `DeliveryDocument`, `BillingDocument`, `JournalEntry`, `Product`, `Address`.

---

## Testing

Unit tests cover all pure utility functions extracted from the LLM pipeline. Tests run with Jest + ts-jest with no external dependencies (no Neo4j, no Gemini API calls).

### Test Suites

| Suite | File | Tests | What is covered |
|-------|------|-------|-----------------|
| `escapeRegExp` | `pipeline-utils.test.ts` | 3 | Special regex characters escaped correctly |
| `compactValue` | `pipeline-utils.test.ts` | 6 | Depth-aware compaction logic, nested objects/arrays |
| `compactRecord` | `pipeline-utils.test.ts` | 3 | Full record object transformation |
| `getMentionCandidates` | `pipeline-utils.test.ts` | 7 | Node ID extraction from graph results |
| `isMutatingCypher` | `pipeline-utils.test.ts` | 18 | All 11 forbidden keywords blocked, safe false-positives pass |

**Total: 37 tests — all passing.**

### Test Files

| File | Purpose |
|------|---------|
| `src/__tests__/pipeline-utils.test.ts` | Unit test suite |
| `src/lib/pipeline-utils.ts` | Extracted pure functions under test |
| `jest.config.js` | ts-jest preset, `@/` alias, node environment |

### Run Tests

```bash
npm test                  # single run
npm run test:watch        # watch mode
```

---

## Stress-Tested Queries

The following queries were run against the live system to validate the full pipeline end-to-end:

| Query | Validates |
|-------|-----------|
| *"Show me all sales orders for customer C1001"* | Basic node filtering |
| *"Which products appear in the most billing documents?"* | Ranking + aggregation |
| *"Trace the full order-to-cash flow for sales order SO-001"* | Multi-hop path traversal |
| *"Which customers have undelivered sales orders?"* | Gap analysis (OPTIONAL MATCH) |
| *"What is the total billed amount per customer?"* | Aggregation + sorting |
| *"Which shipping points handle the most deliveries?"* | Address node queries |
| *"Show journal entries linked to billing document BD-001"* | Deep chain traversal |
| *"What about that customer?"* (follow-up) | Conversation memory |
| *"Delete all nodes"* | Guardrail blocks mutation |
| *"What is the capital of France?"* | Off-topic guardrail |

---

## Deployment

The application is deployed on **Vercel** with zero-config Next.js support.

### Deploy Steps

1. Push to GitHub.
2. Import the repository in [Vercel](https://vercel.com/).
3. Set the four environment variables (`NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `GEMINI_API_KEY`) in **Project Settings > Environment Variables**.
4. Deploy — Vercel auto-detects Next.js and builds the project.

### Production URL

[https://graph-explorer-dodge-ai.vercel.app/](https://graph-explorer-dodge-ai.vercel.app/)

### render.yaml (alternative)

A `render.yaml` is included for one-click Render deployment if needed.