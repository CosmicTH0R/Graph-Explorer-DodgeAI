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

Relationships:
- (Customer)-[:PLACES]->(SalesOrder)
- (SalesOrder)-[:GENERATES]->(DeliveryDocument)
- (DeliveryDocument)-[:BILLED_IN]->(BillingDocument)
- (Customer)-[:BILLED_TO]->(BillingDocument)
- (BillingDocument)-[:ACCOUNTED_IN]->(JournalEntry)
`;

async function geminiChat(prompt: string, model: string = 'gemini-pro', temperature = 0) {
  const chat = genAI.getGenerativeModel({ model });
  const result = await chat.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature } });
  return result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

export async function POST(req: Request) {
  try {
    const { message } = await req.json();

    // 1. GUARDRAIL CHECK
    const guardrailPrompt = `You are a strict security guard. Determine if the user's input is related to querying a business database about orders, deliveries, billing, customers, or supply chain data. Answer STRICTLY with 'YES' or 'NO'. Do not say anything else.\nUser: ${message}`;
    const isRelevant = (await geminiChat(guardrailPrompt, 'gemini-pro', 0)).toUpperCase();
    if (isRelevant !== 'YES') {
      return NextResponse.json({
        reply: 'This system is designed to answer questions related to the provided dataset only.',
        nodes: [], links: []
      });
    }

    // 2. TEXT-TO-CYPHER GENERATION
    const cypherPrompt = `You are a Neo4j Cypher expert. Convert the user's natural language question into a valid Cypher query based on this schema:\n${DB_SCHEMA}\nRULES:\n- Output ONLY the raw Cypher query.\n- Do not use markdown blocks (like \`\`\`cypher).\n- Do not explain the query.\n- Ensure you use MATCH and RETURN statements correctly.\n- To trace a full flow, return the paths. LIMIT results to 50 for performance.\nUser: ${message}`;
    let cypherQuery = await geminiChat(cypherPrompt, 'gemini-pro', 0);
    cypherQuery = cypherQuery.replace(/```cypher/gi, '').replace(/```/g, '').trim();

    // 3. EXECUTE QUERY AGAINST NEO4J
    const session = driver.session();
    let dbData = [];
    try {
      const result = await session.run(cypherQuery);
      dbData = result.records.map(record => {
        let obj: any = {};
        record.keys.forEach((key) => {
          const value = record.get(key);
          if (value && value.properties) obj[key] = value.properties;
          else obj[key] = value;
        });
        return obj;
      });
    } catch (dbError) {
      console.error('Cypher Execution Error:', dbError);
      return NextResponse.json({ reply: "I couldn't find the data for that query in the database.", error: true });
    } finally {
      await session.close();
    }

    // 4. NATURAL LANGUAGE SUMMARIZATION
    const summaryPrompt = `You are a helpful data analyst. Answer the user's question using ONLY the provided database results. Be concise. If the database results are empty, say 'No matching records were found in the dataset.'\nQuestion: ${message}\nDatabase Results: ${JSON.stringify(dbData).substring(0, 3000)}`;
    const finalAnswer = await geminiChat(summaryPrompt, 'gemini-pro', 0.2) || 'Could not generate an answer.';

    return NextResponse.json({
      reply: finalAnswer,
      rawQuery: cypherQuery,
      nodes: [],
      links: []
    });
  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json({ reply: 'An error occurred while processing your request.', status: 500 });
  }
}
