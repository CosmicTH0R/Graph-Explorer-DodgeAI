import { NextResponse } from 'next/server';
import { driver } from '@/lib/neo4j';
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const DB_SCHEMA = `
Node Labels and Key Properties:
- Customer         (id)                      — a buyer/sold-to party
- SalesOrder       (id, totalNetAmount, overallDeliveryStatus, soldToParty, creationDate)
- DeliveryDocument (id, overallGoodsMovementStatus, shippingPoint)
- BillingDocument  (id, totalNetAmount, billingDocumentType, billingDocumentDate, billingDocumentIsCancelled, soldToParty, accountingDocument)
- JournalEntry     (id, accountingDocumentType, postingDate, glAccount, amountInTransactionCurrency)
- Product          (id)                      — a material/product (id = material number)
- Address          (id, type, code, name)    — a physical location (Plant, ShippingPoint, or Location)

Relationships (direction matters):
- (Customer)-[:PLACES]->(SalesOrder)
- (SalesOrder)-[:GENERATES]->(DeliveryDocument)
- (DeliveryDocument)-[:BILLED_IN]->(BillingDocument)
- (Customer)-[:BILLED_TO]->(BillingDocument)
- (BillingDocument)-[:ACCOUNTED_IN]->(JournalEntry)
- (SalesOrder)-[:CONTAINS_ITEM]->(Product)
- (BillingDocument)-[:CONTAINS_ITEM]->(Product)
- (SalesOrder)-[:DELIVERS_TO]->(Address)
- (SalesOrder)-[:SOURCED_FROM]->(Address)
- (DeliveryDocument)-[:SHIPPED_FROM]->(Address)
- (DeliveryDocument)-[:LOCATED_AT]->(Address)

Important query patterns:
- To find top products by billing count: MATCH (b:BillingDocument)-[:CONTAINS_ITEM]->(p:Product) WITH p, COUNT(DISTINCT b) AS cnt ORDER BY cnt DESC RETURN p.id, cnt LIMIT 10
- To trace a billing document full flow (ALWAYS use this exact pattern, returning relationship variables so connections are visible): MATCH (bd:BillingDocument {id: 'X'}) OPTIONAL MATCH (dd:DeliveryDocument)-[r1:BILLED_IN]->(bd) OPTIONAL MATCH (so:SalesOrder)-[r2:GENERATES]->(dd) OPTIONAL MATCH (c:Customer)-[r3:PLACES]->(so) OPTIONAL MATCH (bd)-[r4:ACCOUNTED_IN]->(je:JournalEntry) RETURN bd, dd, r1, so, r2, c, r3, je, r4
- To find sales orders delivered but not billed (ALWAYS return the relationship variable): MATCH (so:SalesOrder)-[r1:GENERATES]->(dd:DeliveryDocument) WHERE NOT (dd)-[:BILLED_IN]->(:BillingDocument) RETURN so, r1, dd LIMIT 50
`;


async function geminiChat(prompt: string, model: string = 'gemini-2.5-flash', temperature = 0) {
  const chat = genAI.getGenerativeModel({ model });
  const result = await chat.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature } });
  return result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

export async function POST(req: Request) {
  try {
    const { message, history } = await req.json();

    // Build conversation context from recent history (last 5 exchanges)
    const recentHistory: { role: string; text: string }[] = Array.isArray(history) ? history.slice(-10) : [];
    const conversationContext = recentHistory.length > 1
      ? '\nRecent conversation:\n' + recentHistory.slice(0, -1).map((m: { role: string; text: string }) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.text ?? '').substring(0, 500)}`).join('\n') + '\n'
      : '';

    // 1. GUARDRAIL CHECK — user input wrapped in delimiters to prevent prompt injection
    const guardrailPrompt = `You are a strict security guard. Determine if the user's input (delimited below) is related to querying a business database about orders, deliveries, billing, customers, or supply chain data. Answer STRICTLY with only the single word YES or NO.
<user_input>${message}</user_input>`;
    let guardrailResponse: string;
    try {
      guardrailResponse = (await geminiChat(guardrailPrompt, 'gemini-2.5-flash', 0)).trim().toUpperCase();
    } catch (e) {
      console.error('Guardrail Gemini error:', e);
      return NextResponse.json({ reply: 'The AI service is temporarily unavailable. Please try again in a moment.' }, { status: 503 });
    }
    if (!/^YES/.test(guardrailResponse)) {
      return NextResponse.json({
        reply: 'This system is designed to answer questions related to the provided dataset only.',
        nodes: [], links: []
      });
    }

    // 2. TEXT-TO-CYPHER GENERATION
    const cypherPrompt = `You are a Neo4j Cypher expert. Convert the user's natural language question into a valid Cypher query based on this schema:
${DB_SCHEMA}
RULES:
- Output ONLY the raw Cypher query. No markdown, no explanation.
- All node IDs are stored as the string property "id" (e.g., \`{id: '90504274'}\`).
- For aggregation/ranking queries: use WITH, COUNT(DISTINCT ...), ORDER BY, LIMIT.
- For "not billed" or "not delivered" queries: use WHERE NOT (...)-[:REL]->(:Label) pattern.
- For tracing a full document flow: use OPTIONAL MATCH to find all connected nodes.
- CRITICAL: ALWAYS return relationship variables (e.g., -[r1:GENERATES]-> not just -[:GENERATES]->) so the frontend graph can render edges between nodes. Without relationship variables, the graph will show disconnected nodes.
- For path tracing, RETURN individual nodes AND relationships (not just RETURN path) so the frontend can render them.
- LIMIT results to 50 unless the query requires more.
- Do not use apoc procedures.
- If the user refers to something from previous conversation (e.g., "that customer", "those orders"), use the conversation context to resolve the reference.
${conversationContext}User: ${message}`;
    let cypherQuery: string;
    try {
      cypherQuery = await geminiChat(cypherPrompt, 'gemini-2.5-flash', 0);
    } catch (e) {
      console.error('Cypher generation Gemini error:', e);
      return NextResponse.json({ reply: 'The AI service is temporarily unavailable. Please try again in a moment.' }, { status: 503 });
    }
    cypherQuery = cypherQuery.replace(/```cypher/gi, '').replace(/```/g, '').trim();
    if (!cypherQuery) {
      return NextResponse.json({ reply: 'I was unable to generate a query for that question. Please rephrase and try again.' });
    }

    // 2.5 READ-ONLY CYPHER ENFORCEMENT — word-boundary regex prevents bypass via SET\n, RESET, OFFSET, etc.
    const forbiddenPatterns = [
      /\bCREATE\b/, /\bDELETE\b/, /\bMERGE\b/, /\bSET\b/, /\bREMOVE\b/,
      /\bDROP\b/, /\bDETACH\b/, /\bFOREACH\b/, /CALL\s+APOC/, /LOAD\s+CSV/,
    ];
    const isMutating = forbiddenPatterns.some(re => re.test(cypherQuery.toUpperCase()));
    if (isMutating) {
      return NextResponse.json({
        reply: 'The generated query was blocked because it attempted to modify the database. Only read-only queries are allowed.',
        nodes: [], links: []
      });
    }

    // 3. EXECUTE QUERY AGAINST NEO4J
    const session = driver.session();
    const dbData: any[] = [];
    const nodeMap = new Map<string, { id: string; label: string; properties: Record<string, unknown> }>();
    const linkSet = new Set<string>();
    const links: { source: string; target: string; type: string }[] = [];

    try {
      const result = await session.run(cypherQuery, {}, { timeout: 30000 });

      result.records.forEach(record => {
        const obj: any = {};
        record.keys.forEach((key) => {
          const value = record.get(key);

          // Neo4j Node
          if (value && value.labels && value.identity != null) {
            const nodeId = value.identity.toString();
            if (!nodeMap.has(nodeId)) {
              nodeMap.set(nodeId, {
                id: nodeId,
                label: value.labels[0] || 'Node',
                properties: value.properties || {},
              });
            }
            obj[key] = value.properties;
          }
          // Neo4j Relationship
          else if (value && value.type && value.start != null && value.end != null) {
            const linkKey = `${value.start}-${value.type}-${value.end}`;
            if (!linkSet.has(linkKey)) {
              linkSet.add(linkKey);
              links.push({ source: value.start.toString(), target: value.end.toString(), type: value.type });
            }
            obj[key] = value.type;
          }
          // Neo4j Path
          else if (value && value.segments) {
            value.segments.forEach((seg: any) => {
              const startId = seg.start.identity.toString();
              const endId = seg.end.identity.toString();
              if (!nodeMap.has(startId)) {
                nodeMap.set(startId, { id: startId, label: seg.start.labels[0] || 'Node', properties: seg.start.properties || {} });
              }
              if (!nodeMap.has(endId)) {
                nodeMap.set(endId, { id: endId, label: seg.end.labels[0] || 'Node', properties: seg.end.properties || {} });
              }
              const linkKey = `${startId}-${seg.relationship.type}-${endId}`;
              if (!linkSet.has(linkKey)) {
                linkSet.add(linkKey);
                links.push({ source: startId, target: endId, type: seg.relationship.type });
              }
            });
            obj[key] = '[path]';
          } else {
            obj[key] = value;
          }
        });
        dbData.push(obj);
      });
    } catch (dbError) {
      console.error('Cypher Execution Error:', dbError);
      return NextResponse.json({ reply: "I couldn't find the data for that query in the database.", error: true });
    } finally {
      await session.close();
    }

    const nodes = Array.from(nodeMap.values());

    // 4. STREAMING NATURAL LANGUAGE SUMMARIZATION via SSE
    const summaryPrompt = `You are a helpful data analyst. Answer the user's question using ONLY the provided database results. If the database results are empty, say 'No matching records were found in the dataset.'
IMPORTANT RULES:
- For "full flow", "trace", or "path" questions: describe EVERY node in the chain. List each hop explicitly with its ID, e.g. Customer → SalesOrder → DeliveryDocument → BillingDocument → JournalEntry. Include all available IDs and key properties (amounts, dates, status, etc.).
- For "delivered but not billed" or similar gap-analysis questions: list EVERY matching pair. For each result, show the Sales Order ID with its key properties (soldToParty, totalNetAmount, creationDate) AND the corresponding Delivery Document ID with its key properties (shippingPoint, delivery date).
- For "top products" or ranking questions: list each result with its rank, ID, and count/value.
- Never omit any entity from the results. Show ALL rows returned by the database.
- Always mention entity IDs explicitly (e.g., Sales Order 740506, Delivery Document 80738091) so they can be highlighted on the graph.
- Use bullet points or numbered lists for clarity.
${conversationContext}Question: ${message}
Database Results: ${JSON.stringify(dbData).substring(0, 3000)}`;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        // Send metadata (graph + query) first
        const meta = JSON.stringify({ rawQuery: cypherQuery, nodes, links });
        controller.enqueue(encoder.encode(`event: meta\ndata: ${meta}\n\n`));

        // Stream summarization tokens
        let fullText = '';
        try {
          const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
          const result = await model.generateContentStream({
            contents: [{ role: 'user', parts: [{ text: summaryPrompt }] }],
            generationConfig: { temperature: 0.2 },
          });
          for await (const chunk of result.stream) {
            const text = chunk.text();
            if (text) {
              fullText += text;
              controller.enqueue(encoder.encode(`event: token\ndata: ${JSON.stringify(text)}\n\n`));
            }
          }
        } catch (e) {
          console.error('Streaming error:', e);
          if (!fullText) {
            fullText = 'Could not generate an answer.';
            controller.enqueue(encoder.encode(`event: token\ndata: ${JSON.stringify(fullText)}\n\n`));
          }
        }

        // Compute highlighted IDs from the full answer
        const highlightedIds: string[] = [];
        for (const node of nodes) {
          const entityId = String(node.properties?.id ?? '');
          if (entityId && new RegExp(`\\b${entityId}\\b`).test(fullText)) {
            highlightedIds.push(node.id);
          }
        }
        controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ highlightedIds })}\n\n`));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json({ reply: 'An error occurred while processing your request.' }, { status: 500 });
  }
}
