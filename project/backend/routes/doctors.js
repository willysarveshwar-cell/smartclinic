const express = require("express");
const router = express.Router();
const db = require("../db");
const { hashPassword, comparePassword, isBcryptHash } = require("../utils/security");
const { notifyQueueUpdateForAppointment } = require("../services/notificationService");
const { authenticate, requireRole } = require("../middleware/auth");

function generateSlots(startTime, endTime) {
  const slots = [];
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);

  let cursor = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;

  while (cursor < end) {
    const hour = Math.floor(cursor / 60);
    const minute = cursor % 60;
    slots.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
    cursor += 30;
  }

  return slots;
}

function ensureDoctorScope(req, doctorId) {
  if (req.user?.role !== "Doctor") return null;

  const tokenDoctorId = Number(req.user?.doctorId);
  if (!Number.isInteger(tokenDoctorId) || tokenDoctorId !== doctorId) {
    return {
      code: 403,
      body: { message: "Forbidden: doctor can only access own records" }
    };
  }

  return null;
}

function timeToMinutes(value) {
  const parts = String(value || "").slice(0, 5).split(":").map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isInteger(n))) return null;
  return parts[0] * 60 + parts[1];
}

function validateNoOverlap(slots) {
  const byDay = new Map();

  for (const slot of slots) {
    const day = Number(slot.day_of_week);
    const start = String(slot.start_time || "").slice(0, 5);
    const end = String(slot.end_time || "").slice(0, 5);
    const startMin = timeToMinutes(start);
    const endMin = timeToMinutes(end);

    if (!Number.isInteger(day) || day < 0 || day > 6 || startMin === null || endMin === null || startMin >= endMin) {
      return { ok: false, message: "Invalid schedule slot. Ensure valid day and start_time < end_time." };
    }

    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ startMin, endMin });
  }

  for (const ranges of byDay.values()) {
    ranges.sort((a, b) => a.startMin - b.startMin);
    for (let i = 1; i < ranges.length; i += 1) {
      if (ranges[i].startMin < ranges[i - 1].endMin) {
        return { ok: false, message: "Schedule conflict: overlapping working hour ranges detected." };
      }
    }
  }

  return { ok: true };
}

/* ================================
   GET ALL DOCTORS
================================ */
router.get("/", async (req, res) => {
  try {
    const search = (req.query.search || "").trim().toLowerCase();
    const sql = search
      ? `SELECT id as doctorId, name, specialization, email FROM doctors WHERE LOWER(name) LIKE ? OR LOWER(specialization) LIKE ? OR LOWER(email) LIKE ? ORDER BY name`
      : `SELECT id as doctorId, name, specialization, email FROM doctors ORDER BY name`;
    const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];
    const results = await db.queryAsync(sql, params);
    res.json(results);
  } catch (err) {
    console.error("❌ Get doctors error:", err.message);
    res.status(500).json({ message: "Database error", detail: err.message });
  }
});

/* ================================
   ADD DOCTOR
================================ */
router.post("/", authenticate, requireRole("Admin"), async (req, res) => {
  const { name, specialization, email, password } = req.body;

  if (!name || !specialization || !email || !password) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const hashedPassword = await hashPassword(password);

    const doctorResult = await db.queryAsync(
      `INSERT INTO doctors (name, specialization, email, password)
       VALUES (?, ?, ?, ?)`,
      [name, specialization, email, hashedPassword]
    );

    await db.queryAsync(
      `INSERT INTO users (fullName, email, password, role, email_verified)
       VALUES (?, ?, ?, 'Doctor', 1)`,
      [name, email, hashedPassword]
    );

    return res.status(201).json({
      message: "Doctor added successfully",
      doctorId: doctorResult.insertId
    });
  } catch (err) {
    console.error("❌ Add doctor SQL error:", err.message);
    return res.status(500).json({ message: "Database error" });
  }
});

/* ================================
   DOCTOR LOGIN (FINAL FIX)
================================ */
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password required" });
  }

  try {
    const results = await db.queryAsync(
      `SELECT id as doctorId, name, specialization, email, password
       FROM doctors
       WHERE email = ?
       LIMIT 1`,
      [email]
    );

    if (!results || results.length === 0) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const doctor = results[0];
    const valid = await comparePassword(password, doctor.password);
    if (!valid) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    if (!isBcryptHash(doctor.password)) {
      const rehashed = await hashPassword(password);
      await db.queryAsync("UPDATE doctors SET password = ? WHERE id = ?", [rehashed, doctor.doctorId]);
    }

    delete doctor.password;
    return res.json({
      success: true,
      doctor
    });
  } catch (err) {
    console.error("❌ Doctor login SQL error:", err.message);
    return res.status(500).json({ message: "Database error" });
  }
});

/* ================================
   GET DOCTOR BY ID
================================ */
router.get("/:id", authenticate, requireRole("Admin"), async (req, res) => {
  try {
    const doctorId = Number(req.params.id);
    if (!Number.isInteger(doctorId) || doctorId <= 0) {
      return res.status(400).json({ message: "Invalid doctor id" });
    }

    const rows = await db.queryAsync(
      `SELECT id as doctorId, name, specialization, email
       FROM doctors
       WHERE id = ?
       LIMIT 1`,
      [doctorId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error("❌ Get doctor by id SQL error:", err.message);
    return res.status(500).json({ message: "Database error" });
  }
});

/* ================================
   DOCTOR – TODAY APPOINTMENTS
================================ */
router.get("/:doctorId/appointments/today", authenticate, requireRole("Doctor", "Admin"), (req, res) => {
  const doctorId = parseInt(req.params.doctorId);

  const scopeError = ensureDoctorScope(req, doctorId);
  if (scopeError) {
    return res.status(scopeError.code).json(scopeError.body);
  }

  const todayD = new Date();
  const todayDStr = todayD.getFullYear() + "-" + String(todayD.getMonth() + 1).padStart(2, "0") + "-" + String(todayD.getDate()).padStart(2, "0");

  const sql = `
    SELECT id as appointmentId, patient_name as patientName, patient_id as patientId, ic_number as icNumber,
           appointment_date as appointmentDate, appointment_time as appointmentTime, status, description
    FROM appointments
    WHERE doctor_id = ?
      AND appointment_date >= ?
      AND status != 'Cancelled'
    ORDER BY appointment_date ASC, appointment_time ASC
  `;

  db.query(sql, [doctorId, todayDStr], (err, results) => {
    if (err) {
      console.error("❌ Today appointments SQL error:", err.message);
      return res.status(500).json({ message: "Database error" });
    }

    res.json(results);
  });
});

/* ================================
   DOCTOR – QUEUE LIST
================================ */
router.get("/:doctorId/queue", authenticate, requireRole("Doctor", "Admin"), (req, res) => {
  const doctorId = parseInt(req.params.doctorId);

  const scopeError = ensureDoctorScope(req, doctorId);
  if (scopeError) {
    return res.status(scopeError.code).json(scopeError.body);
  }

  const todayQ = new Date();
  const todayQStr = todayQ.getFullYear() + "-" + String(todayQ.getMonth() + 1).padStart(2, "0") + "-" + String(todayQ.getDate()).padStart(2, "0");

  const sql = `
    SELECT id as appointmentId, patient_name as patientName, patient_id as patientId, ic_number as icNumber,
           queue_number as queueNumber, status, description
    FROM appointments
    WHERE doctor_id = ?
      AND appointment_date = ?
      AND status IN ('Waiting', 'In Progress')
    ORDER BY queue_number ASC
  `;

  db.query(sql, [doctorId, todayQStr], (err, results) => {
    if (err) {
      console.error("❌ Queue list SQL error:", err.message);
      return res.status(500).json({ message: "Database error" });
    }

    res.json(results);
  });
});

router.get("/:doctorId/availability", authenticate, requireRole("Doctor", "Admin"), async (req, res) => {
  try {
    const doctorId = parseInt(req.params.doctorId, 10);
    const { date } = req.query;

    const scopeError = ensureDoctorScope(req, doctorId);
    if (scopeError) {
      return res.status(scopeError.code).json(scopeError.body);
    }

    if (!date) {
      return res.status(400).json({ message: "date is required (YYYY-MM-DD)" });
    }

    const jsDate = new Date(`${date}T00:00:00`);
    if (Number.isNaN(jsDate.getTime())) {
      return res.status(400).json({ message: "Invalid date format" });
    }

    const leaveRows = await db.queryAsync(
      `SELECT id
       FROM doctor_leaves
       WHERE doctor_id = ?
         AND status = 'Approved'
         AND ? BETWEEN start_date AND end_date
       LIMIT 1`,
      [doctorId, date]
    );

    if (leaveRows.length > 0) {
      return res.json({ doctorId, date, leave: true, slots: [] });
    }

    const dayOfWeek = jsDate.getDay();
    const ranges = await db.queryAsync(
      `SELECT start_time, end_time
       FROM doctor_availability
       WHERE doctor_id = ? AND day_of_week = ? AND is_active = 1
       ORDER BY start_time ASC`,
      [doctorId, dayOfWeek]
    );

    const allSlots = ranges.flatMap((range) =>
      generateSlots(range.start_time.slice(0, 5), range.end_time.slice(0, 5))
    );

    const bookedRows = await db.queryAsync(
      `SELECT appointment_time
       FROM appointments
       WHERE doctor_id = ?
         AND appointment_date = ?
         AND status != 'Cancelled'`,
      [doctorId, date]
    );

    const booked = new Set(bookedRows.map((row) => row.appointment_time.slice(0, 5)));
    const slots = allSlots.map((time) => ({ time, available: !booked.has(time) }));

    return res.json({ doctorId, date, slots });
  } catch (error) {
    console.error("Doctor availability error:", error.message);
    return res.status(500).json({ message: "Failed to load doctor availability" });
  }
});

// Return stored weekly availability patterns for a doctor
router.get('/:doctorId/availability/weekly', authenticate, requireRole('Doctor', 'Admin'), async (req, res) => {
  try {
    const doctorId = parseInt(req.params.doctorId, 10);
    const scopeError = ensureDoctorScope(req, doctorId);
    if (scopeError) return res.status(scopeError.code).json(scopeError.body);

    const rows = await db.queryAsync(
      `SELECT day_of_week, start_time, end_time, is_active
       FROM doctor_availability
       WHERE doctor_id = ?
       ORDER BY day_of_week ASC, start_time ASC`,
      [doctorId]
    );

    return res.json(rows);
  } catch (error) {
    console.error('Get weekly availability error:', error.message);
    return res.status(500).json({ message: 'Failed to load weekly availability' });
  }
});

router.put("/:doctorId/availability", authenticate, requireRole("Doctor", "Admin"), async (req, res) => {
  try {
    const doctorId = parseInt(req.params.doctorId, 10);
    const { slots } = req.body;

    const scopeError = ensureDoctorScope(req, doctorId);
    if (scopeError) {
      return res.status(scopeError.code).json(scopeError.body);
    }

    if (!Array.isArray(slots)) {
      return res.status(400).json({ message: "slots array is required" });
    }

    const normalizedSlots = slots.map((slot) => ({
      day_of_week: Number(slot.day_of_week),
      start_time: String(slot.start_time || "").slice(0, 5),
      end_time: String(slot.end_time || "").slice(0, 5),
      is_active: slot.is_active === 0 ? 0 : 1
    }));

    const overlapCheck = validateNoOverlap(normalizedSlots.filter((slot) => slot.is_active === 1));
    if (!overlapCheck.ok) {
      return res.status(409).json({ message: overlapCheck.message });
    }

    await db.queryAsync("DELETE FROM doctor_availability WHERE doctor_id = ?", [doctorId]);

    for (const slot of normalizedSlots) {
      const day = slot.day_of_week;
      const start = slot.start_time;
      const end = slot.end_time;
      const active = slot.is_active;

      if (!Number.isInteger(day) || day < 0 || day > 6 || !start || !end) continue;

      await db.queryAsync(
        `INSERT INTO doctor_availability (doctor_id, day_of_week, start_time, end_time, is_active)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [doctorId, day, start, end, active]
      );
    }

    return res.json({ message: "Doctor availability updated" });
  } catch (error) {
    console.error("Update doctor availability error:", error.message);
    return res.status(500).json({ message: "Failed to update doctor availability" });
  }
});

router.get("/:doctorId/leaves", authenticate, requireRole("Doctor", "Admin"), async (req, res) => {
  try {
    const doctorId = parseInt(req.params.doctorId, 10);

    const scopeError = ensureDoctorScope(req, doctorId);
    if (scopeError) {
      return res.status(scopeError.code).json(scopeError.body);
    }

    const rows = await db.queryAsync(
      `SELECT id, doctor_id, start_date, end_date, reason, status,
              requested_by_user_id, reviewed_by_user_id, review_notes,
              created_at, reviewed_at
       FROM doctor_leaves
       WHERE doctor_id = ?
       ORDER BY created_at DESC`,
      [doctorId]
    );

    return res.json(rows);
  } catch (error) {
    console.error("Get doctor leaves error:", error.message);
    return res.status(500).json({ message: "Failed to load leave requests" });
  }
});

router.post("/:doctorId/leaves", authenticate, requireRole("Doctor", "Admin"), async (req, res) => {
  try {
    const doctorId = parseInt(req.params.doctorId, 10);
    const { start_date, end_date, reason } = req.body || {};

    const scopeError = ensureDoctorScope(req, doctorId);
    if (scopeError) {
      return res.status(scopeError.code).json(scopeError.body);
    }

    if (!start_date || !end_date) {
      return res.status(400).json({ message: "start_date and end_date are required" });
    }

    if (start_date > end_date) {
      return res.status(400).json({ message: "start_date cannot be later than end_date" });
    }

    const overlapRows = await db.queryAsync(
      `SELECT id
       FROM doctor_leaves
       WHERE doctor_id = ?
         AND status IN ('Pending', 'Approved')
         AND NOT (end_date < ? OR start_date > ?)
       LIMIT 1`,
      [doctorId, start_date, end_date]
    );

    if (overlapRows.length > 0) {
      return res.status(409).json({ message: "Leave request overlaps with an existing leave request" });
    }

    const status = req.user.role === "Admin" ? "Approved" : "Pending";
    const result = await db.queryAsync(
      `INSERT INTO doctor_leaves
       (doctor_id, start_date, end_date, reason, status, requested_by_user_id, reviewed_by_user_id, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        doctorId,
        start_date,
        end_date,
        reason || null,
        status,
        req.user.id,
        req.user.role === "Admin" ? req.user.id : null,
        req.user.role === "Admin" ? new Date() : null
      ]
    );

    return res.status(201).json({
      message: status === "Approved" ? "Leave approved and scheduled" : "Leave request submitted",
      leaveId: result.insertId,
      status
    });
  } catch (error) {
    console.error("Create doctor leave error:", error.message);
    return res.status(500).json({ message: "Failed to submit leave request" });
  }
});

router.put("/leaves/:leaveId/status", authenticate, requireRole("Admin"), async (req, res) => {
  try {
    const leaveId = parseInt(req.params.leaveId, 10);
    const { status, review_notes } = req.body || {};

    if (!["Approved", "Rejected"].includes(status)) {
      return res.status(400).json({ message: "status must be Approved or Rejected" });
    }

    const leaves = await db.queryAsync(
      `SELECT id, doctor_id, start_date, end_date, status
       FROM doctor_leaves
       WHERE id = ?
       LIMIT 1`,
      [leaveId]
    );

    if (leaves.length === 0) {
      return res.status(404).json({ message: "Leave request not found" });
    }

    const leave = leaves[0];
    if (leave.status === status) {
      return res.json({ message: `Leave already ${status.toLowerCase()}` });
    }

    if (status === "Approved") {
      const appointmentConflict = await db.queryAsync(
        `SELECT id
         FROM appointments
         WHERE doctor_id = ?
           AND appointment_date BETWEEN ? AND ?
           AND status IN ('Waiting', 'In Progress')
         LIMIT 1`,
        [leave.doctor_id, leave.start_date, leave.end_date]
      );

      if (appointmentConflict.length > 0) {
        return res.status(409).json({
          message: "Cannot approve leave because active appointments exist in the requested leave period"
        });
      }
    }

    await db.queryAsync(
      `UPDATE doctor_leaves
       SET status = ?,
           review_notes = ?,
           reviewed_by_user_id = ?,
           reviewed_at = NOW()
       WHERE id = ?`,
      [status, review_notes || null, req.user.id, leaveId]
    );

    return res.json({ message: `Leave request ${status.toLowerCase()} successfully` });
  } catch (error) {
    console.error("Review doctor leave error:", error.message);
    return res.status(500).json({ message: "Failed to update leave request" });
  }
});

/* ================================
   UPDATE APPOINTMENT STATUS
================================ */
router.put("/appointment/:appointmentId/status", authenticate, requireRole("Doctor", "Admin"), (req, res) => {
  const appointmentId = parseInt(req.params.appointmentId);
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ message: "Status is required" });
  }

  const fields = ["status = ?", "updated_at = NOW()"];
  const params = [status];

  if (status === "In Progress") {
    fields.push("started_at = COALESCE(started_at, NOW())");
    fields.push("check_in_confirmed = 1");
    fields.push("checked_in_at = COALESCE(checked_in_at, NOW())");
  }

  if (status === "Completed") {
    fields.push("completed_at = NOW()");
    fields.push("check_in_confirmed = 1");
  }

  params.push(appointmentId);

  const sql = `UPDATE appointments SET ${fields.join(", ")} WHERE id = ?`;

  db.query(sql, params, (err, result) => {
    if (err) {
      console.error("❌ Update status SQL error:", err.message);
      return res.status(500).json({ message: "Database error" });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    const io = req.app.get("io");
    if (io) {
      io.emit("queue:updated", { appointmentId, status });
      io.emit("patients:updated", { appointmentId, status });
    }

    notifyQueueUpdateForAppointment(db, appointmentId, { status }).catch((error) => {
      console.error("Doctor appointment notification error:", error.message);
    });

    res.json({ message: "Appointment status updated successfully" });
  });
});

router.get("/:doctorId/medical-records", authenticate, requireRole("Doctor", "Admin"), async (req, res) => {
  try {
    const doctorId = parseInt(req.params.doctorId, 10);
    const { patient_id, ic_number, appointment_id } = req.query;

    const scopeError = ensureDoctorScope(req, doctorId);
    if (scopeError) {
      return res.status(scopeError.code).json(scopeError.body);
    }

    const where = ["mr.doctor_id = ?"];
    const params = [doctorId];

    if (patient_id) {
      where.push("mr.patient_id = ?");
      params.push(Number(patient_id));
    }

    if (ic_number) {
      where.push("(p.ic_number = ? OR a.ic_number = ?)");
      params.push(String(ic_number), String(ic_number));
    }

    if (appointment_id) {
      where.push("mr.appointment_id = ?");
      params.push(Number(appointment_id));
    }

    const rows = await db.queryAsync(
      `SELECT mr.id, mr.patient_id, mr.appointment_id, mr.doctor_id, mr.diagnosis,
              mr.prescriptions, mr.notes, mr.visit_date, mr.created_at, mr.updated_at,
              p.full_name AS patient_name, p.ic_number,
              a.appointment_date, a.appointment_time
       FROM medical_records mr
       LEFT JOIN patients p ON p.id = mr.patient_id
       LEFT JOIN appointments a ON a.id = mr.appointment_id
       WHERE ${where.join(" AND ")}
       ORDER BY mr.visit_date DESC, mr.created_at DESC`,
      params
    );

    return res.json(rows);
  } catch (error) {
    console.error("Get doctor medical records error:", error.message);
    return res.status(500).json({ message: "Failed to load medical records" });
  }
});

router.post("/medical-records", authenticate, requireRole("Doctor", "Admin"), async (req, res) => {
  try {
    const {
      doctor_id,
      patient_id,
      appointment_id,
      diagnosis,
      prescriptions,
      notes,
      visit_date
    } = req.body;

    if (!doctor_id || !appointment_id) {
      return res.status(400).json({ message: "doctor_id and appointment_id are required" });
    }

    const scopeError = ensureDoctorScope(req, Number(doctor_id));
    if (scopeError) {
      return res.status(scopeError.code).json(scopeError.body);
    }

    let resolvedPatientId = patient_id || null;
    if (!resolvedPatientId) {
      const appointmentRows = await db.queryAsync(
        `SELECT a.patient_id, a.ic_number
         FROM appointments a
         WHERE a.id = ?
         LIMIT 1`,
        [appointment_id]
      );

      if (appointmentRows.length > 0) {
        resolvedPatientId = appointmentRows[0].patient_id || null;
        if (!resolvedPatientId && appointmentRows[0].ic_number) {
          const patientRows = await db.queryAsync(
            "SELECT id FROM patients WHERE ic_number = ? LIMIT 1",
            [appointmentRows[0].ic_number]
          );
          if (patientRows.length > 0) {
            resolvedPatientId = patientRows[0].id;
          }
        }
      }
    }

    if (!resolvedPatientId) {
      return res.status(400).json({ message: "Unable to resolve patient_id for this appointment" });
    }

    const existing = await db.queryAsync(
      "SELECT id FROM medical_records WHERE appointment_id = ? LIMIT 1",
      [appointment_id]
    );

    if (existing.length > 0) {
      await db.queryAsync(
        `UPDATE medical_records
         SET diagnosis = ?, prescriptions = ?, notes = ?, visit_date = ?, updated_at = NOW()
         WHERE id = ?`,
        [
          diagnosis || null,
          prescriptions || null,
          notes || null,
          visit_date || new Date().toISOString().split("T")[0],
          existing[0].id
        ]
      );

      return res.json({ message: "Medical record updated", recordId: existing[0].id });
    }

    const result = await db.queryAsync(
      `INSERT INTO medical_records
       (doctor_id, patient_id, appointment_id, diagnosis, prescriptions, notes, visit_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        doctor_id,
        resolvedPatientId,
        appointment_id,
        diagnosis || null,
        prescriptions || null,
        notes || null,
        visit_date || new Date().toISOString().split("T")[0]
      ]
    );

    return res.status(201).json({ message: "Medical record created", recordId: result.insertId });
  } catch (error) {
    console.error("Save medical record error:", error.message);
    return res.status(500).json({ message: "Failed to save medical record" });
  }
});

/* ================================
   UPDATE APPOINTMENT DESCRIPTION
================================ */
router.put("/appointment/:appointmentId/description", authenticate, requireRole("Doctor", "Admin"), (req, res) => {
  const appointmentId = parseInt(req.params.appointmentId);
  const { description } = req.body;

  const sql = `
    UPDATE appointments
    SET description = ?
    WHERE id = ?
  `;

  db.query(sql, [description, appointmentId], (err, result) => {
    if (err) {
      console.error("❌ Update description SQL error:", err.message);
      return res.status(500).json({ message: "Database error" });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    const io = req.app.get("io");
    if (io) {
      io.emit("patients:updated", { appointmentId, descriptionUpdated: true });
    }

    res.json({ message: "Appointment description updated successfully" });
  });
});

/* ================================
   GET APPOINTMENT BY ID
================================ */
router.get("/appointment/:appointmentId", authenticate, requireRole("Doctor", "Admin"), (req, res) => {
  const appointmentId = parseInt(req.params.appointmentId);

  const sql = `
    SELECT id as appointmentId, patient_name as patientName, patient_id as patientId, ic_number as icNumber,
           doctor_id as doctorId, appointment_date as appointmentDate, appointment_time as appointmentTime,
           status, description
    FROM appointments
    WHERE id = ?
  `;

  db.query(sql, [appointmentId], (err, results) => {
    if (err) {
      console.error("❌ Get appointment SQL error:", err.message);
      return res.status(500).json({ message: "Database error" });
    }

    if (results.length === 0) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    res.json(results[0]);
  });
});

/* ================================
   UPDATE DOCTOR
================================ */
router.put("/:id", authenticate, requireRole("Admin"), async (req, res) => {
  try {
    const { name, specialization, email, password } = req.body;

    if (!name || !specialization || !email) {
      return res.status(400).json({ message: "Name, specialization and email are required" });
    }

    const doctorId = Number(req.params.id);
    const normalizedEmail = String(email).trim().toLowerCase();

    const existingRows = await db.queryAsync("SELECT email, password FROM doctors WHERE id = ? LIMIT 1", [doctorId]);
    if (existingRows.length === 0) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    const previousEmail = String(existingRows[0].email || "").toLowerCase();
    const previousPassword = String(existingRows[0].password || "");
    const updates = [name, specialization, normalizedEmail, doctorId];
    let doctorSql = "UPDATE doctors SET name = ?, specialization = ?, email = ? WHERE id = ?";
    let doctorParams = updates;
    let userSql = "UPDATE users SET fullName = ?, email = ? WHERE LOWER(email) = ? AND LOWER(role) = 'doctor'";
    let userUpdateParams = [name, normalizedEmail, previousEmail];
    let finalPassword = previousPassword;

    if (password) {
      finalPassword = await hashPassword(password);
      doctorSql = "UPDATE doctors SET name = ?, specialization = ?, email = ?, password = ? WHERE id = ?";
      doctorParams = [name, specialization, normalizedEmail, finalPassword, doctorId];
      userSql = "UPDATE users SET fullName = ?, email = ?, password = ? WHERE LOWER(email) = ? AND LOWER(role) = 'doctor'";
      userUpdateParams = [name, normalizedEmail, finalPassword, previousEmail];
    }

    await db.queryAsync(doctorSql, doctorParams);
    const userUpdateResult = await db.queryAsync(userSql, userUpdateParams);

    if (userUpdateResult.affectedRows === 0) {
      await db.queryAsync(
        `INSERT INTO users (fullName, email, password, role, email_verified)
         VALUES (?, ?, ?, 'Doctor', 1)`,
        [name, normalizedEmail, finalPassword]
      );
    }

    res.json({ message: "Doctor updated successfully" });
  } catch (err) {
    console.error("❌ Update doctor SQL error:", err.message);
    return res.status(500).json({ message: "Database error" });
  }
});

/* ================================
   DELETE DOCTOR
================================ */
router.delete("/:id", authenticate, requireRole("Admin"), async (req, res) => {
  try {
    const doctorId = Number(req.params.id);
    const rows = await db.queryAsync("SELECT email FROM doctors WHERE id = ? LIMIT 1", [doctorId]);

    if (rows.length === 0) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    const appointmentRows = await db.queryAsync(
      `SELECT id FROM appointments WHERE doctor_id = ? LIMIT 1`,
      [doctorId]
    );

    if (appointmentRows.length > 0) {
      return res.status(409).json({
        message: "Doctor cannot be deleted while appointments exist. Cancel or reassign appointments first."
      });
    }

    const doctorEmail = String(rows[0].email || "").toLowerCase();

    await db.queryAsync("DELETE FROM doctors WHERE id = ?", [doctorId]);
    await db.queryAsync("DELETE FROM users WHERE LOWER(email) = ? AND LOWER(role) = 'doctor'", [doctorEmail]);

    res.json({ message: "Doctor deleted successfully" });
  } catch (err) {
    console.error("❌ Delete doctor SQL error:", err.message);
    return res.status(500).json({ message: "Database error" });
  }
});

module.exports = router;
