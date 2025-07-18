import postgres from 'postgres';

const sql = postgres('postgres://admin:123@rinha-db:5432/rinha', {
  max: 8,
  idle_timeout: 20,
  connect_timeout: 3,
  prepare: false,
  transform: {
    undefined: null
  },
  connection: {
    application_name: 'rinha-backend'
  }
});

export default sql;
