// db.js
import mysql from 'mysql2/promise';
import 'dotenv/config'; // Carrega as variáveis de .env

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT, // Importante para Railway
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Usamos 'export default' em vez de 'module.exports'
export default pool;
