import { NextResponse } from 'next/server';
import { driver } from '@/lib/neo4j';

export async function GET() {
  const session = driver.session();
  const nodeMap = new Map<string, { id: string; label: string; properties: Record<string, unknown> }>();
  const linkSet = new Set<string>();
  const links: { source: string; target: string; type: string }[] = [];

  try {
    // Fetch the full supply chain graph excluding Product nodes (too many to render)
    // Returns up to 400 non-Product nodes and all relationships between them
    const result = await session.run(
      `MATCH (n)-[r]->(m)
       WHERE NOT n:Product AND NOT m:Product
       RETURN n, r, m
       LIMIT 400`,
      {},
      { timeout: 20000 }
    );

    result.records.forEach(record => {
      const n = record.get('n');
      const nId = n.identity.toString();
      if (!nodeMap.has(nId)) {
        nodeMap.set(nId, { id: nId, label: n.labels[0] || 'Node', properties: n.properties || {} });
      }

      const m = record.get('m');
      const mId = m.identity.toString();
      if (!nodeMap.has(mId)) {
        nodeMap.set(mId, { id: mId, label: m.labels[0] || 'Node', properties: m.properties || {} });
      }

      const r = record.get('r');
      const startId = r.start.toString();
      const endId   = r.end.toString();
      const linkKey = `${startId}-${r.type}-${endId}`;
      if (!linkSet.has(linkKey)) {
        linkSet.add(linkKey);
        links.push({ source: startId, target: endId, type: r.type });
      }
    });
  } finally {
    await session.close();
  }

  return NextResponse.json({ nodes: Array.from(nodeMap.values()), links });
}
