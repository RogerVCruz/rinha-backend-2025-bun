import postgres from 'postgres';

const sql = postgres('postgres://admin:123@rinha-db:5432/rinha', {
  max: 30, 
  idle_timeout: 30, // Reduced idle timeout
  connect_timeout: 30, // Faster connection timeout
  prepare: false,
  transform: {
    undefined: null // Handle undefined values properly
  },
  connection: {
    application_name: 'rinha-backend'
  }
});

export default sql;
