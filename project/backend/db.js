const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, ".env") });
const { Pool } = require("pg");

// Active pool — set to either real Supabase or in-memory pg-mem
let _pool = null;
let _usesRealPool = false;
let _connectionError = null;

function buildPoolConfig() {
  // Prefer individual params to avoid URL %40-encoding issues with @ in passwords
  if (process.env.DB_HOST) {
    return {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || "5432"),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || "postgres",
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000,
      max: 10,
    };
  }
  return {
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30000,
    max: 10,
  };
}

const _connectionReady = (async () => {
  if (process.env.SUPABASE_DB_URL || process.env.DB_HOST) {
    try {
      const realPool = new Pool(buildPoolConfig());
      const client = await realPool.connect();
      client.release();
      _pool = realPool;
      _usesRealPool = true;
      // Create the doctors table synchronously so seeds below always succeed
      await realPool.query(`
        CREATE TABLE IF NOT EXISTS doctors (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          specialization VARCHAR(100) NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          avg_consultation_minutes INTEGER DEFAULT 15
        )
      `).catch(() => {});
      // Seed essential doctors synchronously (idempotent)
      await realPool.query(`INSERT INTO doctors (name, specialization, email, password) VALUES ('Dr. John Doe', 'General Medicine', 'doctor@example.com', 'password123') ON CONFLICT DO NOTHING`).catch(() => {});
      await realPool.query(`INSERT INTO doctors (name, specialization, email, password) VALUES ('Default Doctor', 'General Medicine', 'doctor@clinic.com', '123456') ON CONFLICT DO NOTHING`).catch(() => {});
      // Synchronously ensure critical columns exist before any query runs
      await ensureColumn(realPool, "patients", "date_of_birth", "DATE");
      await ensureColumn(realPool, "patients", "gender", "VARCHAR(10)");
      await ensureColumn(realPool, "patients", "needs_follow_up", "SMALLINT DEFAULT 0");
      await ensureColumn(realPool, "appointments", "reminder_notified_at", "TIMESTAMP");
      await ensureColumn(realPool, "appointments", "missed_notified_at", "TIMESTAMP");
      await ensureColumn(realPool, "doctors", "avg_consultation_minutes", "INTEGER DEFAULT 15");
      console.log("✅ Supabase PostgreSQL Connected Successfully");
    } catch (err) {
      const shortMsg = (err.message || "").split("\n")[0];
      _connectionError = shortMsg;
      console.warn(`⚠️  Supabase unreachable (${shortMsg})`);
      console.log("🔄 Switching to in-memory database for local development...");
      _pool = createMemPool();
      // For pg-mem fallback: run schema init synchronously so tables exist before first query
      await initializeSchema(_pool);
    }
  } else {
    console.log("ℹ️  No SUPABASE_DB_URL or DB_HOST — using in-memory database");
    _pool = createMemPool();
    // For pg-mem: run schema init synchronously so tables/seed exist before first query
    await initializeSchema(_pool);
  }
})();

// For Supabase only: run full schema init in background (CREATE TABLE, indexes, seeds)
_connectionReady.then(() => {
  if (_usesRealPool) {
    initializeSchema(_pool).catch((e) => {
      console.error("❌ Schema init error:", e && e.message ? e.message : e);
    });
  }
});

function createMemPool() {
  let pgMem;
  try {
    pgMem = require("pg-mem");
  } catch (e) {
    console.error("❌ pg-mem not installed. Run: npm install pg-mem");
    throw e;
  }
  const memDb = pgMem.newDb();
  const adapters = memDb.adapters.createPg();
  const MemPool = adapters.Pool;
  const pool = new MemPool();
  console.log("✅ In-memory database ready (data resets on restart, for local dev only)");
  return pool;
}

async function getPool() {
  // Wait for connection with a 6-second safety cap so no query hangs indefinitely
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Database not ready (connection timeout)")), 6000)
  );
  await Promise.race([_connectionReady, timeout]);
  return _pool;
}

// Convert MySQL ? placeholders to PostgreSQL $1, $2, ...
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// PostgreSQL lowercases all unquoted identifiers; restore the camelCase names
// the route code expects, including SQL aliases like "id as appointmentId".
const CAMEL_MAP = {
  userid: "userId",
  fullname: "fullName",
  contactnumber: "contactNumber",
  createddate: "createdDate",
  appointmentid: "appointmentId",
  patientname: "patientName",
  patientid: "patientId",
  icnumber: "icNumber",
  appointmentdate: "appointmentDate",
  appointmenttime: "appointmentTime",
  queuenumber: "queueNumber",
  doctorid: "doctorId",
  doctorname: "doctorName",
};

function normalizeRow(row) {
  if (!row || typeof row !== "object") return row;
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    result[CAMEL_MAP[key] || key] = value;
  }
  return result;
}

function extractInsertId(row) {
  if (!row) return null;
  const normalized = normalizeRow(row);
  return normalized.id !== undefined ? normalized.id
    : normalized.userId !== undefined ? normalized.userId
    : null;
}

const db = {};

db.query = function (sql, params, callback) {
  if (typeof params === "function") { callback = params; params = []; }
  const cleanSql = sql.trim();
  const isSqlInsert = /^\s*INSERT\s+/i.test(cleanSql);
  let pgSql = convertPlaceholders(cleanSql);
  if (isSqlInsert && !/RETURNING/i.test(pgSql)) {
    pgSql = pgSql.replace(/;\s*$/, "") + " RETURNING *";
  }
  getPool()
    .then((pool) => pool.query(pgSql, params || []))
    .then((result) => {
      if (isSqlInsert) {
        const row = result.rows[0] || null;
        callback(null, { insertId: extractInsertId(row), affectedRows: result.rowCount });
      } else if (/^\s*(UPDATE|DELETE)\s+/i.test(cleanSql)) {
        callback(null, { insertId: null, affectedRows: result.rowCount });
      } else {
        callback(null, result.rows.map(normalizeRow));
      }
    })
    .catch((err) => callback(err, null));
};

db.queryAsync = async function (sql, params = []) {
  const pool = await getPool();
  const cleanSql = sql.trim();
  const isSqlInsert = /^\s*INSERT\s+/i.test(cleanSql);
  let pgSql = convertPlaceholders(cleanSql);
  if (isSqlInsert && !/RETURNING/i.test(pgSql)) {
    pgSql = pgSql.replace(/;\s*$/, "") + " RETURNING *";
  }
  const result = await pool.query(pgSql, params || []);
  if (isSqlInsert) {
    const row = result.rows[0] || null;
    return { insertId: extractInsertId(row), affectedRows: result.rowCount };
  }
  if (/^\s*(UPDATE|DELETE)\s+/i.test(cleanSql)) {
    return { insertId: null, affectedRows: result.rowCount };
  }
  return result.rows.map(normalizeRow);
};

// Convert MySQL column type strings to PostgreSQL equivalents
function mysqlTypeToPg(typeDef) {
  return typeDef
    .replace(/TINYINT\s+DEFAULT\s+0/gi, "SMALLINT DEFAULT 0")
    .replace(/TINYINT/gi, "SMALLINT")
    .replace(/DATETIME/gi, "TIMESTAMP")
    .replace(/\bINT\b(?!\s*EGER)/gi, "INTEGER")
    .replace(/JSON\s+NULL/gi, "JSONB")
    .replace(/\bJSON\b/gi, "JSONB")
    .replace(/\s+NULL\s*$/i, "")
    .trim();
}

async function ensureColumn(pool, tableName, columnName, columnDefinition) {
  try {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [tableName, columnName]
    );
    if (result.rowCount === 0) {
      const pgType = mysqlTypeToPg(columnDefinition);
      await pool.query(`ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "${columnName}" ${pgType}`);
    }
  } catch (_e) {
    // Non-fatal: column already exists or table doesn't exist yet
  }
}

async function ensureIndex(pool, indexName, tableName, columnsSql) {
  try {
    await pool.query(`CREATE INDEX "${indexName}" ON "${tableName}" (${columnsSql})`);
  } catch (e) {
    if (e.code !== "42P07") {
      // Ignore duplicate index errors silently; log others but don't crash
    }
  }
}

async function initializeSchema(pool) {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50),
        password VARCHAR(100)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        userId SERIAL PRIMARY KEY,
        fullName VARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL,
        linked_patient_id INTEGER NULL,
        email_verified SMALLINT DEFAULT 0,
        verification_token VARCHAR(128),
        verification_expires_at TIMESTAMP,
        refresh_token VARCHAR(255),
        refresh_expires_at TIMESTAMP,
        last_login_at TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        phone VARCHAR(30),
        ic_number VARCHAR(30) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        date_of_birth DATE,
        gender VARCHAR(10),
        needs_follow_up SMALLINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS doctors (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        specialization VARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        avg_consultation_minutes INTEGER DEFAULT 15
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        patient_name VARCHAR(100) NOT NULL,
        ic_number VARCHAR(30) NOT NULL,
        patient_email VARCHAR(255),
        patient_phone VARCHAR(30),
        doctor_id INTEGER NOT NULL,
        appointment_date VARCHAR(10) NOT NULL,
        appointment_time VARCHAR(10) NOT NULL,
        queue_number INTEGER NOT NULL,
        status VARCHAR(30) DEFAULT 'Waiting',
        description TEXT,
        follow_up SMALLINT DEFAULT 0,
        patient_id INTEGER,
        check_in_token VARCHAR(10),
        check_in_confirmed SMALLINT DEFAULT 0,
        checked_in_at TIMESTAMP,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP,
        FOREIGN KEY (doctor_id) REFERENCES doctors(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS doctor_availability (
        id SERIAL PRIMARY KEY,
        doctor_id INTEGER NOT NULL,
        day_of_week SMALLINT NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        is_active SMALLINT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS doctor_leaves (
        id SERIAL PRIMARY KEY,
        doctor_id INTEGER NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        reason TEXT,
        status VARCHAR(20) DEFAULT 'Pending',
        requested_by_user_id INTEGER NULL,
        reviewed_by_user_id INTEGER NULL,
        review_notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        reviewed_at TIMESTAMP NULL,
        FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS medical_records (
        id SERIAL PRIMARY KEY,
        doctor_id INTEGER NOT NULL,
        patient_id INTEGER NOT NULL,
        appointment_id INTEGER NOT NULL,
        diagnosis TEXT,
        prescriptions TEXT,
        notes TEXT,
        visit_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL,
        FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE,
        FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
        FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        appointment_id INTEGER,
        event_type VARCHAR(64) NULL,
        channel VARCHAR(20) NOT NULL,
        recipient VARCHAR(255),
        message TEXT,
        sent_status VARCHAR(20) DEFAULT 'logged',
        details TEXT NULL,
        sent_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_settings (
        id INTEGER PRIMARY KEY,
        email_enabled SMALLINT DEFAULT 1,
        sms_enabled SMALLINT DEFAULT 0,
        appointment_confirmation_email SMALLINT DEFAULT 1,
        appointment_confirmation_sms SMALLINT DEFAULT 0,
        appointment_reminder_email SMALLINT DEFAULT 1,
        appointment_reminder_sms SMALLINT DEFAULT 0,
        queue_updates_enabled SMALLINT DEFAULT 1,
        missed_appointment_enabled SMALLINT DEFAULT 1,
        reminder_lead_minutes INTEGER DEFAULT 1440,
        missed_grace_minutes INTEGER DEFAULT 30,
        smtp_server VARCHAR(255) NULL,
        smtp_port INTEGER NULL,
        smtp_username VARCHAR(255) NULL,
        sms_provider VARCHAR(50) NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_audit_logs (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(64) NOT NULL,
        status VARCHAR(20) NOT NULL,
        user_id INTEGER NULL,
        email VARCHAR(255) NULL,
        role VARCHAR(20) NULL,
        ip_address VARCHAR(64) NULL,
        user_agent VARCHAR(255) NULL,
        details TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await ensureIndex(pool, "idx_doctor_leave_range", "doctor_leaves", "doctor_id, start_date, end_date");
    await ensureIndex(pool, "idx_doctor_leave_status", "doctor_leaves", "status");
    await ensureIndex(pool, "idx_auth_audit_created", "auth_audit_logs", "created_at");
    await ensureIndex(pool, "idx_auth_audit_email", "auth_audit_logs", "email");
    await ensureIndex(pool, "idx_auth_audit_user", "auth_audit_logs", "user_id");

    await ensureColumn(pool, "patients", "needs_follow_up", "SMALLINT DEFAULT 0");
    await ensureColumn(pool, "appointments", "patient_id", "INTEGER");
    await ensureColumn(pool, "appointments", "patient_email", "TEXT");
    await ensureColumn(pool, "appointments", "patient_phone", "TEXT");
    await ensureColumn(pool, "appointments", "follow_up", "SMALLINT DEFAULT 0");
    await ensureColumn(pool, "appointments", "check_in_token", "VARCHAR(10)");
    await ensureColumn(pool, "appointments", "check_in_confirmed", "SMALLINT DEFAULT 0");
    await ensureColumn(pool, "appointments", "checked_in_at", "TIMESTAMP");
    await ensureColumn(pool, "appointments", "started_at", "TIMESTAMP");
    await ensureColumn(pool, "appointments", "completed_at", "TIMESTAMP");
    await ensureColumn(pool, "appointments", "updated_at", "TIMESTAMP");
    await ensureColumn(pool, "appointments", "description", "TEXT");
    await ensureColumn(pool, "appointments", "reminder_notified_at", "TIMESTAMP");
    await ensureColumn(pool, "appointments", "missed_notified_at", "TIMESTAMP");
    await ensureColumn(pool, "doctors", "avg_consultation_minutes", "INTEGER DEFAULT 15");
    await ensureColumn(pool, "doctors", "available_time", "VARCHAR(100)");
    await ensureColumn(pool, "patients", "date_of_birth", "DATE");
    await ensureColumn(pool, "patients", "gender", "VARCHAR(10)");
    await ensureColumn(pool, "users", "contactnumber", "VARCHAR(20)");
    await ensureColumn(pool, "users", "status", "VARCHAR(20) DEFAULT 'Active'");
    await ensureColumn(pool, "users", "createddate", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
    await ensureColumn(pool, "users", "linked_patient_id", "INTEGER");
    await ensureColumn(pool, "users", "email_verified", "SMALLINT DEFAULT 0");
    await ensureColumn(pool, "users", "verification_token", "VARCHAR(128)");
    await ensureColumn(pool, "users", "verification_expires_at", "TIMESTAMP");
    await ensureColumn(pool, "users", "refresh_token", "VARCHAR(255)");
    await ensureColumn(pool, "users", "refresh_expires_at", "TIMESTAMP");
    await ensureColumn(pool, "users", "last_login_at", "TIMESTAMP");
    await ensureColumn(pool, "notifications", "event_type", "VARCHAR(64)");
    await ensureColumn(pool, "notifications", "details", "TEXT");
    await ensureColumn(pool, "notifications", "sent_at", "TIMESTAMP");

    await ensureIndex(pool, "idx_apts_doctor_date_time", "appointments", "doctor_id, appointment_date, appointment_time");
    await ensureIndex(pool, "idx_apts_date_status", "appointments", "appointment_date, status");

    // Seed default data for local development
    await pool.query(`INSERT INTO doctors (name, specialization, email, password) VALUES ('Dr. John Doe', 'General Medicine', 'doctor@example.com', 'password123') ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO doctors (name, specialization, email, password) VALUES ('Default Doctor', 'General Medicine', 'doctor@clinic.com', '123456') ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO users (fullName, email, password, role, email_verified) VALUES ('Admin User', 'admin@clinic.com', 'admin123', 'Admin', 1) ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO users (fullName, email, password, role, email_verified) VALUES ('Dr. John Doe', 'doctor@example.com', 'password123', 'Doctor', 1) ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO users (fullName, email, password, role, email_verified) VALUES ('Default Doctor', 'doctor@clinic.com', '123456', 'Doctor', 1) ON CONFLICT DO NOTHING`);

    await pool.query(`
      INSERT INTO users (fullName, email, password, role, email_verified)
      SELECT d.name, d.email, d.password, 'Doctor', 1 FROM doctors d
      ON CONFLICT DO NOTHING
    `);

    await pool.query(`
      INSERT INTO users (fullName, email, password, role, linked_patient_id, email_verified)
      SELECT p.full_name, p.email, p.password, 'Patient', p.id, 1 FROM patients p
      ON CONFLICT DO NOTHING
    `);

    await pool.query(`
      INSERT INTO notification_settings
        (id, email_enabled, sms_enabled, appointment_confirmation_email, appointment_confirmation_sms,
         appointment_reminder_email, appointment_reminder_sms, queue_updates_enabled,
         missed_appointment_enabled, reminder_lead_minutes, missed_grace_minutes)
      VALUES (1, 1, 0, 1, 0, 1, 0, 1, 1, 1440, 30)
      ON CONFLICT (id) DO NOTHING
    `);

    await pool.query(`UPDATE users SET email_verified = 1 WHERE role IN ('Admin', 'Doctor') AND (email_verified IS NULL OR email_verified = 0)`);

    console.log("✅ Database schema ready");
  } catch (error) {
    console.error("❌ Schema initialization error:", error && error.message ? error.message : error);
  }
}

db.usesRealPool = () => _usesRealPool;
db.connectionError = () => _connectionError;

module.exports = db;
