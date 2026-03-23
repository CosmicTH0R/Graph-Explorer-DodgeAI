# LLM-Powered Graph Explorer

> **Live Demo:** [https://graph-explorer-dodge-ai.vercel.app/](https://graph-explorer-dodge-ai.vercel.app/)

A full-stack application for exploring SAP supply chain data using natural language. Ask plain-English questions, get LLM-generated Cypher queries executed live against Neo4j AuraDB, and watch results rendered as an interactive force-directed graph � in real time.

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
11. [Stress-Tested Queries](#stress-tested-queries)
12. [Deployment](#deployment)

---

## Features

- **Natural language to Cypher** � Ask *"Which products appear in the most billing documents?"* and receive a live-executed Cypher query with results.
- **Streaming responses** � Answers stream token-by-token via Server-Sent Events using `generateContentStream()` for a real-time feel.
- **Pre-loaded overview graph** � On page load, all non-Product nodes and their relationships are fetched automatically so the canvas is never blank.
- **Interactive graph visualization** � Results rendered with `react-force-graph-2d`; nodes color-coded by label with a dynamic legend.
- **Zoom-to-node** � Left-clicking a node centers and zooms to it (6� zoom, 600 ms animation).
- **Node expansion** � Right-click any node to fetch and merge its direct neighbors from Neo4j without resetting the graph.
- **Node inspection** � Click any node to view all its properties in a scrollable floating panel.
- **Highlighted references** � Entity IDs mentioned in the LLM answer are automatically outlined in yellow on the graph.
- **Markdown rendering** � LLM answers render with full Markdown (bold, lists, headings) via `react-markdown`.
- **Conversation memory** � Last 10 messages sent as context so follow-up questions resolve correctly (e.g. *"what about that customer?"*).
- **Guardrail** � Off-topic queries blocked before any Cypher is generated.
- **Read-only enforcement** � Regex word-boundary checks block all mutating Cypher keywords.
- **30-second query timeout** � Runaway Neo4j queries cancelled automatically.

---

## Architecture

```
+-----------------------------------------+
�           Browser (Next.js)             �
�  ChatSidebar  �  GraphCanvas            �
�  NodeInspector�  Legend                 �
+-----------------------------------------+
           � SSE  POST /api/chat
           �      POST /api/expand
           �      GET  /api/overview
+----------?------------------------------+
�         Next.js API Routes              �
�                                         �
�  +- /api/chat ----------------------+   �
�  � 1. Guardrail          (Gemini)   �   �
�  � 2. Text-to-Cypher     (Gemini)   �   �
�  � 3. Read-only check    (regex)    �   �
�  � 4. Neo4j execution    (30s max)  �   �
�  � 5. Streaming summary  (Gemini)   �   �
�  +----------------------------------+   �
�  /api/overview  � initial graph load    �
�  /api/expand    � neighbor fetch        �
+-----------------------------------------+
           � Bolt (neo4j+s://)
+----------?------------------------------+
�           Neo4j AuraDB                  �
�   7 node types � 11 relationship types  �
+-----------------------------------------+
```

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16 (React 19), Tailwind CSS v4 |
| Graph rendering | react-force-graph-2d 1.29 |
| Markdown rendering | react-markdown |
| Backend | Next.js API Routes |
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

**Database stats:** ~20,309 Product nodes � 14 Address nodes � 137 GENERATES edges � 245 BILLED_IN edges � 490 Address edges.

---

## LLM Pipeline

Every user message passes through a four-stage pipeline in `src/app/api/chat/route.ts`.

### Stage 1 � Guardrail
```
Model: gemini-2.5-flash    Temperature: 0
```
User input is wrapped in `<user_input>�</user_input>` XML delimiters (prompt injection protection) and sent to Gemini with the instruction to return only `YES` or `NO`.

- Strict equality check: `guardrailResponse !== 'YES'` � any deviation blocks the query.
- On block: returns `"This system is designed to answer questions related to the provided dataset only."`

### Stage 2 � Text-to-Cypher
```
Model: gemini-2.5-flash    Temperature: 0
```
- Full DB schema (7 labels, 11 relationships, key property names) injected into the prompt.
- Last 10 messages of conversation history included for follow-up resolution.
- Curated pattern hints for common queries (flow tracing, ranking by count, gap analysis).
- **CRITICAL rule enforced in prompt:** always return relationship variables (e.g. `-[r1:GENERATES]->`) so the frontend graph can render edges.

### Stage 2.5 � Read-Only Enforcement
Regex word-boundary patterns applied to the generated Cypher before execution:

```ts
/\bCREATE\b/, /\bDELETE\b/, /\bMERGE\b/, /\bSET\b/, /\bREMOVE\b/,
/\bDROP\b/, /\bDETACH\b/, /\bFOREACH\b/, /CALL\s+APOC/, /LOAD\s+CSV/, /CALL\s*\{/
```

Word-boundary matching prevents bypasses via `SET\n`, `RESET`, `OFFSET`, or subquery injection (`CALL {}`).

### Stage 3 � Neo4j Execution
- Query executed with a 30-second timeout.
- Result records parsed for three value types:
  - **Neo4j Node** ? extracted to `{ id, label, properties }`
  - **Relationship** ? stored as `{ source, target, type }`
  - **Path** ? segments unpacked into nodes + edges
- Results compacted with depth-aware `compactRecord()`: top-level property maps preserved in full; nested objects/arrays replaced with `[object]` / `[array:N]` to save prompt tokens.

### Stage 4 � Streaming Summarization
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
|---------|-----------|
| Prompt injection | `<user_input>` XML delimiters isolate user content from system instructions |
| Guardrail bypass | `guardrailResponse !== 'YES'` strict equality (not `.includes()`) |
| Write operations | 11 regex word-boundary patterns covering all mutation keywords + `CALL {}` subqueries |
| False-positive highlights | `escapeRegExp()` + `\b�\b` prevents ID "123" matching "2123 units" |
| Query hangs | 30-second timeout on every `session.run()` call |
| Label injection | Expand endpoint validates `label` against allowlist of 7 known types |
| SSE memory leaks | `AbortController` cancelled on component unmount via `useEffect` cleanup |

---

## Project Structure

```
graph-explorer/
+-- data/                          # Raw JSONL source files (49 files)
+-- etl/
�   +-- ingest.py                  # Main ETL � nodes + relationships from JSONL
�   +-- ingest_addresses.py        # Address node ETL (Plant, ShippingPoint, Location)
+-- src/
�   +-- app/
�   �   +-- layout.tsx
�   �   +-- page.tsx               # Orchestrator � state, SSE handling, graph merge
�   �   +-- api/
�   �       +-- chat/
�   �       �   +-- route.ts       # 4-stage LLM pipeline + SSE streaming
�   �       +-- overview/
�   �       �   +-- route.ts       # Initial graph load (all non-Product nodes)
�   �       +-- expand/
�   �           +-- route.ts       # Neighbor expansion (right-click)
�   +-- components/
�   �   +-- types.ts               # Shared interfaces + LABEL_COLOURS map
�   �   +-- ChatSidebar.tsx        # Chat UI � messages, streaming cursor, Markdown
�   �   +-- GraphCanvas.tsx        # Force-directed graph with zoom, highlight, dim
�   �   +-- Legend.tsx             # Dynamic color legend + expanding indicator
�   �   +-- NodeInspector.tsx      # Floating scrollable node property panel
�   +-- lib/
�       +-- neo4j.ts               # Neo4j driver singleton (process-exit cleanup)
+-- .env.example                   # Required env var template
+-- package.json
+-- tsconfig.json                  # TypeScript strict mode, path alias @/*
+-- README.md
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```env
GEMINI_API_KEY=your_gemini_api_key_here
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_neo4j_password_here
```

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google AI Studio API key � [get one here](https://aistudio.google.com/app/apikey) |
| `NEO4J_URI` | AuraDB Bolt URI from your Neo4j console (`neo4j+s://�`) |
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
cp .env.example .env
# Edit .env and fill in your API keys

# 3. Start the dev server
npm run dev
# App available at http://localhost:3000
```

Other scripts:

```bash
npm run build    # Production build
npm run start    # Serve production build locally
npm run lint     # ESLint check
```

---

## ETL Setup

**Prerequisites:** Python 3.9+, Neo4j credentials in `.env`

```bash
# 1. Create and activate a virtual environment
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate     # macOS / Linux

# 2. Install dependencies
pip install pandas neo4j python-dotenv

# 3. Run the main ETL (nodes + relationships)
python etl/ingest.py
# Parses 49 JSONL files
# Uploads ~1,398 entity nodes + 20,309 Product nodes
# Creates all 11 relationship types

# 4. Run the Address ETL
python etl/ingest_addresses.py
# Creates 14 Address nodes (7 Plant, 5 ShippingPoint, 2 Location)
# Creates 490 address-related edges
```

Both scripts are idempotent � they use `MERGE` with unique constraints, so re-running them will not create duplicate nodes or relationships.

---

## API Reference

### `GET /api/overview`

Returns all non-Product nodes and their relationships for the initial graph load.

**Response:**
```json
{
  "nodes": [ { "id": "42", "label": "Customer", "properties": { "id": "320000083" } } ],
  "links": [ { "source": "42", "target": "71", "type": "PLACES" } ]
}
```

- Excludes Product nodes (20,309 � too many to load upfront).
- Returns up to 400 nodes with a 20-second timeout.

---

### `POST /api/chat`

Runs the full LLM pipeline and streams the response.

**Request body:**
```json
{
  "message": "Which customers have the most sales orders?",
  "history": [
    { "role": "user",      "text": "Show me all customers" },
    { "role": "assistant", "text": "Found 12 customers in the dataset." }
  ]
}
```

**Response:** `Content-Type: text/event-stream`

```
event: meta
data: {"nodes":[...],"links":[...],"rawQuery":"MATCH (c:Customer)-[r:PLACES]->(so:SalesOrder)..."}

event: token
data: "The customer with the most orders is"

event: token
data: " 320000083 with 47 sales orders."

event: done
data: {"highlightedIds":["42","17"]}
```

**Error responses (JSON, non-streaming):**
```json
{ "reply": "This system is designed to answer questions related to the provided dataset only." }
{ "reply": "The generated query was blocked because it attempted to modify the database." }
{ "reply": "I couldn't find the data for that query in the database.", "error": true }
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
    { "id": "123", "label": "SalesOrder",  "properties": { "id": "740571", "totalNetAmount": 9802 } },
    { "id": "456", "label": "Customer",    "properties": { "id": "320000083" } }
  ],
  "links": [
    { "source": "456", "target": "123", "type": "PLACES" }
  ]
}
```

- Returns up to 50 neighbors (bidirectional relationship traversal).
- `label` is validated against a server-side allowlist of 7 known types. Unknown labels return `HTTP 400`.

---

## Stress-Tested Queries

The following queries were used to validate full-pipeline correctness:

| Query | Expected Behavior |
|-------|------------------|
| *"Which products are associated with the highest number of billing documents?"* | Aggregates `CONTAINS_ITEM` edges, returns `Product` nodes ranked by billing count |
| *"Trace the full flow of billing document 90504274."* | Returns chain: Customer 320000083 ? SalesOrder 740571 ? DeliveryDocument 80738091 ? BillingDocument 90504274 ? JournalEntry 9400000275 |
| *"Identify sales orders that have delivered but not billed flows."* | Uses `WHERE NOT (dd)-[:BILLED_IN]->(:BillingDocument)` pattern, returns SO + DD pairs |
| *"Write a poem about a supply chain."* | Blocked by guardrail � returns off-topic message |
| *"Who is the president of the US?"* | Blocked by guardrail � returns off-topic message |

---

## Deployment

The app deploys automatically to **Vercel** on every push to `main`.

**Live URL:** [https://graph-explorer-dodge-ai.vercel.app/](https://graph-explorer-dodge-ai.vercel.app/)

Set the four environment variables in your Vercel project under **Settings ? Environment Variables** (same names as in `.env`).

---

## Acknowledgments

Built for the Forward Deployed Engineer (FDE) assignment.  
Powered by **Neo4j AuraDB**, **Gemini 2.5 Flash**, **Next.js 16**, **React 19**, and **Tailwind CSS v4**.
