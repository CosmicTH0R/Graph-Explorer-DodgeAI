"""
ETL add-on: Creates Address (location) nodes and relationships in Neo4j.

Extracts physical locations from existing entity properties:
  - shippingPoint  on DeliveryDocument headers  → (DeliveryDocument)-[:SHIPPED_FROM]->(Address)
  - plant          on DeliveryDocument items     → (DeliveryDocument)-[:LOCATED_AT]->(Address)
  - productionPlant on SalesOrder items          → (SalesOrder)-[:SOURCED_FROM]->(Address)
  - incotermsLocation1 on SalesOrder headers     → (SalesOrder)-[:DELIVERS_TO]->(Address)
"""

import json
import glob
from neo4j import GraphDatabase
import os
from dotenv import load_dotenv
from collections import defaultdict

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
NEO4J_URI = os.getenv("NEO4J_URI")
NEO4J_USER = os.getenv("NEO4J_USERNAME")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD")


def parse_addresses(file_pattern="data/*.jsonl"):
    """Scan all JSONL files and extract address/location references."""
    addresses = {}  # id -> {id, type, ...}
    edges = []

    files = glob.glob(file_pattern)
    print(f"Scanning {len(files)} files for address data...")

    for file in files:
        with open(file, 'r') as f:
            for line in f:
                if not line.strip():
                    continue
                rec = json.loads(line)

                has_billing  = 'billingDocument' in rec
                has_delivery = 'deliveryDocument' in rec or 'outboundDelivery' in rec
                has_so       = 'salesOrder' in rec

                # --- DeliveryDocument Header: shippingPoint ---
                if has_delivery and 'deliveryDocumentItem' not in rec:
                    doc_id = rec.get('deliveryDocument') or rec.get('outboundDelivery')
                    sp = rec.get('shippingPoint')
                    if sp and doc_id:
                        addr_id = f"SP_{sp}"
                        addresses[addr_id] = {"id": addr_id, "type": "ShippingPoint", "code": sp}
                        edges.append({"from_label": "DeliveryDocument", "from_id": doc_id,
                                      "to_id": addr_id, "rel": "SHIPPED_FROM"})

                # --- DeliveryDocument Item: plant ---
                elif has_delivery and 'deliveryDocumentItem' in rec:
                    doc_id = rec.get('deliveryDocument') or rec.get('outboundDelivery')
                    plant = rec.get('plant')
                    if plant and doc_id:
                        addr_id = f"PLANT_{plant}"
                        addresses[addr_id] = {"id": addr_id, "type": "Plant", "code": plant}
                        edges.append({"from_label": "DeliveryDocument", "from_id": doc_id,
                                      "to_id": addr_id, "rel": "LOCATED_AT"})

                # --- SalesOrder Header: incotermsLocation1 ---
                elif has_so and 'salesOrderType' in rec:
                    doc_id = rec['salesOrder']
                    loc = rec.get('incotermsLocation1')
                    if loc and doc_id:
                        addr_id = f"LOC_{loc}"
                        addresses[addr_id] = {"id": addr_id, "type": "Location", "name": loc}
                        edges.append({"from_label": "SalesOrder", "from_id": doc_id,
                                      "to_id": addr_id, "rel": "DELIVERS_TO"})

                    # productionPlant from items won't be on header, skip here
                    pass

                # --- SalesOrder Item: productionPlant ---
                elif has_so and 'salesOrderItem' in rec:
                    so_id = rec['salesOrder']
                    plant = rec.get('productionPlant') or rec.get('plant')
                    if plant and so_id:
                        addr_id = f"PLANT_{plant}"
                        addresses[addr_id] = {"id": addr_id, "type": "Plant", "code": plant}
                        edges.append({"from_label": "SalesOrder", "from_id": so_id,
                                      "to_id": addr_id, "rel": "SOURCED_FROM"})

    return addresses, edges


def push_to_neo4j(addresses, edges):
    print(f"\nConnecting to Neo4j...")
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

    with driver.session() as session:
        # 1. Constraint
        print("Creating Address constraint...")
        session.run("CREATE CONSTRAINT IF NOT EXISTS FOR (n:Address) REQUIRE n.id IS UNIQUE")

        # 2. Create Address nodes
        addr_list = list(addresses.values())
        print(f"Uploading {len(addr_list)} Address nodes...")
        session.run("""
            UNWIND $batch AS row
            MERGE (a:Address {id: row.id})
            SET a += row
        """, batch=addr_list)

        # 3. Create edges grouped by (from_label, rel)
        grouped = defaultdict(list)
        for e in edges:
            key = (e["from_label"], e["rel"])
            grouped[key].append({"from_id": e["from_id"], "to_id": e["to_id"]})

        queries = {
            ("DeliveryDocument", "SHIPPED_FROM"): """
                UNWIND $batch AS row
                MATCH (d:DeliveryDocument {id: row.from_id})
                MATCH (a:Address {id: row.to_id})
                MERGE (d)-[:SHIPPED_FROM]->(a)
            """,
            ("DeliveryDocument", "LOCATED_AT"): """
                UNWIND $batch AS row
                MATCH (d:DeliveryDocument {id: row.from_id})
                MATCH (a:Address {id: row.to_id})
                MERGE (d)-[:LOCATED_AT]->(a)
            """,
            ("SalesOrder", "DELIVERS_TO"): """
                UNWIND $batch AS row
                MATCH (s:SalesOrder {id: row.from_id})
                MATCH (a:Address {id: row.to_id})
                MERGE (s)-[:DELIVERS_TO]->(a)
            """,
            ("SalesOrder", "SOURCED_FROM"): """
                UNWIND $batch AS row
                MATCH (s:SalesOrder {id: row.from_id})
                MATCH (a:Address {id: row.to_id})
                MERGE (s)-[:SOURCED_FROM]->(a)
            """,
        }

        print("Uploading Address edges...")
        for key, batch in grouped.items():
            if key in queries:
                session.run(queries[key], batch=batch)
                print(f"  -> {key[0]} -[{key[1]}]-> Address: {len(batch)} edges")
            else:
                print(f"  ! Skipping unknown key: {key}")

    driver.close()
    print("\n✅ Address nodes and relationships created successfully!")


if __name__ == "__main__":
    addresses, edges = parse_addresses()
    print(f"\nFound {len(addresses)} unique Address nodes")
    print(f"Found {len(edges)} Address edges")

    # Breakdown
    from collections import Counter
    type_counts = Counter(a["type"] for a in addresses.values())
    for t, c in sorted(type_counts.items()):
        print(f"  {t}: {c}")
    edge_counts = Counter(e["rel"] for e in edges)
    for r, c in sorted(edge_counts.items()):
        print(f"  {r}: {c}")

    push_to_neo4j(addresses, edges)
