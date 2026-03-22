import { NextResponse } from 'next/server';
import { driver } from '@/lib/neo4j';
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const DB_SCHEMA = `
Nodes:
- Customer (id)
- SalesOrder (id)
- DeliveryDocument (id)
- BillingDocument (id)
- JournalEntry (id)
- Product (id)

Relationships:
- (Customer)-[:PLACES]->(SalesOrder)
- (SalesOrder)-[:GENERATES]->(DeliveryDocument)
- (DeliveryDocument)-[:BILLED_IN]->(BillingDocument)
- (Customer)-[:BILLED_TO]->(BillingDocument)
- (BillingDocument)-[:ACCOUNTED_IN]->(JournalEntry)
- (SalesOrder)-[:CONTAINS_ITEM]->(Product)
- (DeliveryDocument)-[:CONTAINS_ITEM]->(Product)
- (BillingDocument)-[:CONTAINS_ITEM]->(Product)
`;

async function geminiChat(prompt: string, model: string = 'gemini-2.5-flash', temperature = 0) {
  const chat = genAI.getGenerativeModel({ model });
  const result = await chat.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature } });
  return result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

export async function POST(req: Request) {
  try {
    const { message } = await req.json();

    // 1. GUARDRAIL CHECK
    const guardrailPrompt = `You are a strict security guard. Determine if the user's input is related to querying a business database about orders, deliveries, billing, customers, or supply chain data. Answer STRICTLY with 'YES' or 'NO'. Do not say anything else.\nUser: ${message}`;
    const isRelevant = (await geminiChat(guardrailPrompt, 'gemini-2.5-flash', 0)).toUpperCase();
    if (!isRelevant.includes('YES')) {
      return NextResponse.json({
        reply: 'This system is designed to answer questions related to the provided dataset only.',
        nodes: [], links: []
      });
    }

    // 2. TEXT-TO-CYPHER GENERATION
    const cypherPrompt = `You are a Neo4j Cypher expert. Convert the user's natural language question into a valid Cypher query based on this schema:\n${DB_SCHEMA}\nRULES:\n- Output ONLY the raw Cypher query.\n- Do not use markdown blocks (like \`\`\`cypher).\n- Do not explain the query.\n- Ensure you use MATCH and RETURN statements correctly.\n- To trace a full flow, return the paths. LIMIT results to 50 for performance.\nUser: ${message}`;
    let cypherQuery = await geminiChat(cypherPrompt, 'gemini-2.5-flash', 0);
    cypherQuery = cypherQuery.replace(/```cypher/gi, '').replace(/```/g, '').trim();

    // 3. EXECUTE QUERY AGAINST NEO4J
    const session = driver.session();
    const dbData: any[] = [];
    const nodeMap = new Map<string, { id: string; label: string; properties: Record<string, unknown> }>();
    const linkSet = new Set<string>();
    const links: { source: string; target: string; type: string }[] = [];

    try {
      const result = await session.run(cypherQuery);

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

    // 4. NATURAL LANGUAGE SUMMARIZATION
    const summaryPrompt = `You are a helpful data analyst. Answer the user's question using ONLY the provided database results. Be concise. If the database results are empty, say 'No matching records were found in the dataset.'\nQuestion: ${message}\nDatabase Results: ${JSON.stringify(dbData).substring(0, 3000)}`;
    const finalAnswer = await geminiChat(summaryPrompt, 'gemini-2.5-flash', 0.2) || 'Could not generate an answer.';

    return NextResponse.json({ reply: finalAnswer, rawQuery: cypherQuery, nodes, links });
  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json({ reply: 'An error occurred while processing your request.', status: 500 });
  }
}
