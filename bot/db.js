const url = require('url');
const DEBUG = !!process.env.DEBUG_DB;
const DB_TYPE = (process.env.DATABASE_TYPE || 'postgres').toLowerCase();

let client = null;

async function init() {
    if (DB_TYPE === 'mysql') {
        const mysql = require('mysql2/promise');
        // mysql2 supports a connection string
        client = mysql.createPool(process.env.DATABASE_URL, { waitForConnections: true, connectionLimit: 10, queueLimit: 0, multipleStatements: false });
    } else {
        const { Pool } = require('pg');
        client = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
    }
}

function pgParamsToQMarks(sql) {
    // replace $1, $2 ... with ? for mysql
    return sql.replace(/\$\d+/g, '?');
}

async function query(sql, params = []) {
    if (!client) await init();
    if (DB_TYPE === 'mysql') {
        const s = pgParamsToQMarks(sql);
        if (DEBUG) console.log('[DB][MYSQL]', s, params);
        const [rows] = await client.execute(s, params);
        return { rows };
    } else {
        if (DEBUG) console.log('[DB][PG]', sql, params);
        const res = await client.query(sql, params);
        return res;
    }
}

module.exports = { init, query, DB_TYPE };
