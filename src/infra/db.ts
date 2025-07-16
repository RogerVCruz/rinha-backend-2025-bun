import postgres from 'postgres';

const sql = postgres('postgres://admin:123@rinha-db:5432/rinha', {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 30,
  prepare: false,
  transform: {
    undefined: null
  },
  connection: {
    application_name: 'rinha-backend'
  }
});

export default sql;
