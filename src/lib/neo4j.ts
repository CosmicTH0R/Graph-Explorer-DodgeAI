import neo4j from 'neo4j-driver';

const uri = process.env.NEO4J_URI || '';
const user = process.env.NEO4J_USERNAME || '';
const password = process.env.NEO4J_PASSWORD || '';

export const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

// Ensure the driver is closed when the app shuts down
process.on('exit', () => {
  driver.close();
});
