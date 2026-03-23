import { NextResponse } from 'next/server';
import { driver } from '@/lib/neo4j';

export async function POST(req: Request) {
  try {
    const { nodeId, label } = await req.json();
    if (!nodeId || !label) {
      return NextResponse.json({ error: 'nodeId and label are required' }, { status: 400 });
    }

    // Only allow known labels to prevent injection
    const allowedLabels = ['Customer', 'SalesOrder', 'DeliveryDocument', 'BillingDocument', 'JournalEntry', 'Product', 'Address'];
    if (!allowedLabels.includes(label)) {
      return NextResponse.json({ error: 'Invalid label' }, { status: 400 });
    }

    const session = driver.session();
    const nodeMap = new Map<string, { id: string; label: string; properties: Record<string, unknown> }>();
    const linkSet = new Set<string>();
    const links: { source: string; target: string; type: string }[] = [];

    try {
      // Fetch the node and all its directly connected neighbors (both directions)
      const cypher = `MATCH (n:${label} {id: $nodeId})-[r]-(m) RETURN n, r, m LIMIT 50`;
      const result = await session.run(cypher, { nodeId: String(nodeId) });

      result.records.forEach(record => {
        // Source node
        const n = record.get('n');
        const nId = n.identity.toString();
        if (!nodeMap.has(nId)) {
          nodeMap.set(nId, { id: nId, label: n.labels[0] || 'Node', properties: n.properties || {} });
        }

        // Neighbor node
        const m = record.get('m');
        const mId = m.identity.toString();
        if (!nodeMap.has(mId)) {
          nodeMap.set(mId, { id: mId, label: m.labels[0] || 'Node', properties: m.properties || {} });
        }

        // Relationship (preserve original direction)
        const r = record.get('r');
        const startId = r.start.toString();
        const endId = r.end.toString();
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
  } catch (error) {
    console.error('Expand API Error:', error);
    return NextResponse.json({ error: 'Failed to expand node' }, { status: 500 });
  }
}
