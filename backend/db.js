require("dotenv").config();
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "smart_clinic",
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true
});

pool.getConnection()
  .then((conn) => { console.log("✅ MySQL Connected Successfully"); conn.release(); })
  .catch((err) => { console.error("❌ MySQL connection failed:", err.message); });

const db = {};

db.query = function (sql, params, callback) {
  if (typeof params === "function") { callback = params; params = []; }
  pool.query(sql, params || [])
    .then(([result]) => {
      if (Array.isArray(result)) {
        callback(null, result);
      } else {
        callback(null, { insertId: result.insertId, affectedRows: result.affectedRows });
      }
    })
    .catch((err) => callback(err, null));
};

db.queryAsync = async function (sql, params = []) {
  const [result] = await pool.query(sql, params);
  if (Array.isArray(result)) return result;
  return { insertId: result.insertId, affectedRows: result.affectedRows };
};

async function ensureColumn(tableName, columnName, columnDefinition) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [process.env.DB_NAME || "smart_clinic", tableName, columnName]
  );
  if (rows.length === 0) {
    await pool.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${columnDefinition}`);
  }
}

async function ensureIndex(indexName, tableName, columnsSql) {
  try {
    await pool.query(`CREATE INDEX \`${indexName}\` ON \`${tableName}\` (${columnsSql})`);
  } catch (e) {
    if (e.code !== "ER_DUP_KEYNAME") throw e;
  }
}

async function initializeSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      userId INT PRIMARY KEY AUTO_INCREMENT,
      fullName VARCHAR(100) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL,
      linked_patient_id INT NULL,
      email_verified TINYINT DEFAULT 0,
      verification_token VARCHAR(128),
      verification_expires_at DATETIME,
      refresh_token VARCHAR(255),
      refresh_expires_at DATETIME,
      last_login_at DATETIME
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS patients (
      id INT PRIMARY KEY AUTO_INCREMENT,
      full_name VARCHAR(100) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      phone VARCHAR(30),
      ic_number VARCHAR(30) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      needs_follow_up TINYINT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS doctors (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(100) NOT NULL,
      specialization VARCHAR(100) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      avg_consultation_minutes INT DEFAULT 15
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id INT PRIMARY KEY AUTO_INCREMENT,
      patient_name VARCHAR(100) NOT NULL,
      ic_number VARCHAR(30) NOT NULL,
      patient_email VARCHAR(255),
      patient_phone VARCHAR(30),
      doctor_id INT NOT NULL,
      appointment_date VARCHAR(10) NOT NULL,
      appointment_time VARCHAR(10) NOT NULL,
      queue_number INT NOT NULL,
      status VARCHAR(30) DEFAULT 'Waiting',
      description TEXT,
      follow_up TINYINT DEFAULT 0,
      patient_id INT,
      check_in_token VARCHAR(10),
      check_in_confirmed TINYINT DEFAULT 0,
      checked_in_at DATETIME,
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME,
      UNIQUE KEY uq_checkin (appointment_date, check_in_token),
      FOREIGN KEY (doctor_id) REFERENCES doctors(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS doctor_availability (
      id INT PRIMARY KEY AUTO_INCREMENT,
      doctor_id INT NOT NULL,
      day_of_week TINYINT NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      is_active TINYINT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_doctor_day_time (doctor_id, day_of_week, start_time, end_time),
      FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS doctor_leaves (
      id INT PRIMARY KEY AUTO_INCREMENT,
      doctor_id INT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      reason TEXT,
      status VARCHAR(20) DEFAULT 'Pending',
      requested_by_user_id INT NULL,
      reviewed_by_user_id INT NULL,
      review_notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME NULL,
      FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE,
      INDEX idx_doctor_leave_range (doctor_id, start_date, end_date),
      INDEX idx_doctor_leave_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS medical_records (
      id INT PRIMARY KEY AUTO_INCREMENT,
      doctor_id INT NOT NULL,
      patient_id INT NOT NULL,
      appointment_id INT NOT NULL,
      diagnosis TEXT,
      prescriptions TEXT,
      notes TEXT,
      visit_date DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_medical_record_appointment (appointment_id),
      FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE,
      FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
      FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INT PRIMARY KEY AUTO_INCREMENT,
      appointment_id INT,
      event_type VARCHAR(64) NULL,
      channel VARCHAR(20) NOT NULL,
      recipient VARCHAR(255),
      message TEXT,
      sent_status VARCHAR(20) DEFAULT 'logged',
      details JSON NULL,
      sent_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_settings (
      id INT PRIMARY KEY,
      email_enabled TINYINT DEFAULT 1,
      sms_enabled TINYINT DEFAULT 0,
      appointment_confirmation_email TINYINT DEFAULT 1,
      appointment_confirmation_sms TINYINT DEFAULT 0,
      appointment_reminder_email TINYINT DEFAULT 1,
      appointment_reminder_sms TINYINT DEFAULT 0,
      queue_updates_enabled TINYINT DEFAULT 1,
      missed_appointment_enabled TINYINT DEFAULT 1,
      reminder_lead_minutes INT DEFAULT 1440,
      missed_grace_minutes INT DEFAULT 30,
      smtp_server VARCHAR(255) NULL,
      smtp_port INT NULL,
      smtp_username VARCHAR(255) NULL,
      sms_provider VARCHAR(50) NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_audit_logs (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      event_type VARCHAR(64) NOT NULL,
      status VARCHAR(20) NOT NULL,
      user_id INT NULL,
      email VARCHAR(255) NULL,
      role VARCHAR(20) NULL,
      ip_address VARCHAR(64) NULL,
      user_agent VARCHAR(255) NULL,
      details JSON NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_auth_audit_created (created_at),
      INDEX idx_auth_audit_email (email),
      INDEX idx_auth_audit_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await ensureColumn("patients", "needs_follow_up", "TINYINT DEFAULT 0");
  await ensureColumn("appointments", "patient_id", "INTEGER");
  await ensureColumn("appointments", "patient_email", "TEXT");
  await ensureColumn("appointments", "patient_phone", "TEXT");
  await ensureColumn("appointments", "follow_up", "TINYINT DEFAULT 0");
  await ensureColumn("appointments", "check_in_token", "VARCHAR(10)");
  await ensureColumn("appointments", "check_in_confirmed", "TINYINT DEFAULT 0");
  await ensureColumn("appointments", "checked_in_at", "DATETIME");
  await ensureColumn("appointments", "started_at", "DATETIME");
  await ensureColumn("appointments", "completed_at", "DATETIME");
  await ensureColumn("appointments", "updated_at", "DATETIME");
  await ensureColumn("appointments", "description", "TEXT NULL");
  await ensureColumn("appointments", "reminder_notified_at", "DATETIME NULL");
  await ensureColumn("appointments", "missed_notified_at", "DATETIME NULL");
  await ensureColumn("doctors", "avg_consultation_minutes", "INT DEFAULT 15");
  await ensureColumn("patients", "date_of_birth", "DATE NULL");
  await ensureColumn("patients", "gender", "VARCHAR(10) NULL");
  await ensureColumn("users", "linked_patient_id", "INT NULL");
  await ensureColumn("users", "email_verified", "TINYINT DEFAULT 0");
  await ensureColumn("users", "verification_token", "VARCHAR(128)");
  await ensureColumn("users", "verification_expires_at", "DATETIME");
  await ensureColumn("users", "refresh_token", "VARCHAR(255)");
  await ensureColumn("users", "refresh_expires_at", "DATETIME");
  await ensureColumn("users", "last_login_at", "DATETIME");
  await ensureColumn("notifications", "event_type", "VARCHAR(64) NULL");
  await ensureColumn("notifications", "details", "JSON NULL");
  await ensureColumn("notifications", "sent_at", "DATETIME NULL");

  await ensureIndex("idx_apts_doctor_date_time", "appointments", "doctor_id, appointment_date, appointment_time");
  await ensureIndex("idx_apts_date_status", "appointments", "appointment_date, status");

  await pool.query(`INSERT IGNORE INTO doctors (name, specialization, email, password) VALUES ('Dr. John Doe', 'General Medicine', 'doctor@example.com', 'password123')`);
  await pool.query(`INSERT IGNORE INTO doctors (name, specialization, email, password) VALUES ('Default Doctor', 'General Medicine', 'doctor@clinic.com', '123456')`);
  await pool.query(`INSERT IGNORE INTO users (fullName, email, password, role, email_verified) VALUES ('Admin User', 'admin@clinic.com', 'admin123', 'Admin', 1)`);
  await pool.query(`INSERT IGNORE INTO users (fullName, email, password, role, email_verified) VALUES ('Dr. John Doe', 'doctor@example.com', 'password123', 'Doctor', 1)`);
  await pool.query(`INSERT IGNORE INTO users (fullName, email, password, role, email_verified) VALUES ('Default Doctor', 'doctor@clinic.com', '123456', 'Doctor', 1)`);

  await pool.query(`
    INSERT IGNORE INTO users (fullName, email, password, role, email_verified)
    SELECT d.name, d.email, d.password, 'Doctor', 1 FROM doctors d
  `);

  await pool.query(`
    INSERT IGNORE INTO users (fullName, email, password, role, linked_patient_id, email_verified)
    SELECT p.full_name, p.email, p.password, 'Patient', p.id, 1 FROM patients p
  `);

  await pool.query(`
    INSERT IGNORE INTO notification_settings
      (id, email_enabled, sms_enabled, appointment_confirmation_email, appointment_confirmation_sms,
       appointment_reminder_email, appointment_reminder_sms, queue_updates_enabled,
       missed_appointment_enabled, reminder_lead_minutes, missed_grace_minutes)
    VALUES (1, 1, 0, 1, 0, 1, 0, 1, 1, 1440, 30)
  `);

  // Backward-compatible migration for legacy accounts created before verification was introduced.
  await pool.query("UPDATE users SET email_verified = 1 WHERE role IN ('Admin', 'Doctor') AND (email_verified IS NULL OR email_verified = 0)");
}

initializeSchema().catch((error) => {
  console.error("❌ Failed to initialize schema:", error.message);
});

module.exports = db;
