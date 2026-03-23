# LLM-Powered Graph Explorer

## Overview
A full-stack application for exploring business supply chain data using natural language queries, powered by Neo4j AuraDB, Next.js, and Gemini LLM. The system enables users to ask complex questions about orders, billing, and flows, and visualizes the results as interactive graphs.

---

## Architecture Decisions
- **Three-tier modular design:**
  - **ETL Layer (Python):** Extracts and transforms raw JSONL data into graph entities and relationships.
  - **Backend/API (Next.js):** Handles user queries, LLM prompting, Cypher generation, and Neo4j integration.
  - **Frontend (React + Tailwind CSS):** Provides a chat interface and dynamic graph visualization using `react-force-graph-2d`.
- **Database:**
  - **Neo4j AuraDB** was chosen for its native graph traversal, relationship modeling, and efficient handling of supply chain queries that are difficult with relational databases.
- **LLM Integration:**
  - **Gemini LLM** is used for natural language to Cypher translation and summarization.

---

## Database Choice
- **Neo4j AuraDB** enables:
  - Efficient modeling of entities (Customer, SalesOrder, DeliveryDocument, BillingDocument, JournalEntry, Product) and relationships (PLACES, GENERATES, BILLED_IN, ACCOUNTED_IN, CONTAINS_ITEM).
  - Fast traversal and aggregation queries for supply chain analytics.

---

## LLM Prompting Strategy
- **Guardrail Prompt:**
  - All user queries are first checked by Gemini with a strict prompt: "Is this query related to business supply chain, orders, billing, or the provided dataset? Answer YES or NO."
  - If NO, the system blocks the query and returns a guardrail message.
- **Schema Injection:**
  - The full Neo4j schema is injected into the LLM prompt to ensure accurate Cypher generation.
- **Multi-stage Pipeline:**
  1. Guardrail check
  2. Cypher query generation
  3. Neo4j execution
  4. LLM-based summarization of results

---

## How It Works
1. **ETL:** Python script parses all .jsonl files, creates nodes and relationships in Neo4j.
2. **Backend:** Next.js API receives user queries, runs guardrail and Cypher prompts, executes queries, and summarizes results.
3. **Frontend:** React app displays chat, graph, and node details interactively.

---

## Live Demo
**Deployed on Vercel:** [https://graph-explorer-dodge-ai.vercel.app/](https://graph-explorer-dodge-ai.vercel.app/)

---

## Setup & Deployment
1. Clone the repo and install dependencies for both Python (ETL) and Node.js (app).
2. Set up `.env` with Neo4j and Gemini credentials.
3. Run the ETL script to populate Neo4j.
4. Start the Next.js app (`npm run dev`).
5. Access the app in your browser and start exploring!

---

## Key Files
- `etl/ingest.py` — ETL script for Neo4j
- `src/app/api/chat/route.ts` — LLM pipeline and API logic
- `src/app/page.tsx` — Main chat and graph UI
- `.env` — Secrets and credentials

---

## Acknowledgments
- Built for the Forward Deployed Engineer assignment.
- Powered by Neo4j AuraDB, Gemini LLM, Next.js, and Tailwind CSS.
