import postgres from 'postgres';

const sql = postgres('postgres://admin:123@rinha-db:5432/rinha');

export default sql;
