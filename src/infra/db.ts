import postgres from 'postgres';

const sql = postgres('postgres://admin:123@rinha-db:5432/rinha', {
  max: 20,
  idle_timeout: 20,
  connect_timeout: 5,
  prepare: false
});

export default sql;
