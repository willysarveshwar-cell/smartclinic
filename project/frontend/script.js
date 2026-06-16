/* -------- NAVIGATION -------- */
function goHome() {
  window.location.href = "index.html";
}

function goBack() {
  window.history.back();
}

function goAppointment() {
  window.location.href = "appointment.html";
}

function goQueue() {
  window.location.href = "queue.html";
}

function goCheckIn() {
  window.location.href = "check-in.html";
}

function goDoctor() {
  window.location.href = "doctor-login.html";
}

function goAdmin() {
  window.location.href = "admin.html";
}

/* -------- APPOINTMENT BOOKING -------- */
function bookAppointment() {
  const name = document.getElementById("name").value.trim();
  const ic = document.getElementById("ic").value.trim();
  const emailInput = document.getElementById("email");
  const phoneInput = document.getElementById("phone");
  const doctorId = document.getElementById("doctor").value;
  const date = document.getElementById("date").value;
  const time = document.getElementById("time").value;
  const email = emailInput ? emailInput.value.trim() : "";
  const phone = phoneInput ? phoneInput.value.trim() : "";

  if (!name || !ic || !doctorId || !date || !time) {
    showPopup("Please fill in all fields", false);
    return;
  }

  if (ic.length < 6) {
    showPopup("IC Number must be at least 6 characters", false);
    return;
  }

  if (email && !/^\S+@\S+\.\S+$/.test(email)) {
    showPopup("Please enter a valid email address", false);
    return;
  }

  fetch("/api/appointments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      patient_name: name,
      ic_number: ic,
      doctor_id: parseInt(doctorId),
      appointment_date: date,
      appointment_time: time,
      patient_email: email || null,
      patient_phone: phone || null
    })
  })
  .then(res => res.json().then(data => ({ res, data })))
  .then(({ res, data }) => {
    if (!res.ok) {
      const errorMsg = data.errors ? data.errors[0] : (data.message || 'Booking failed. Please try again.');
      throw new Error(errorMsg);
    }
    showPopup("Appointment booked successfully! Your Queue Number: " + data.queue_number, true, data);
    document.getElementById("name").value = "";
    document.getElementById("ic").value = "";
    document.getElementById("doctor").value = "";
    document.getElementById("date").value = "";
    document.getElementById("time").value = "";
  })
  .catch(err => {
    const msg = err.message === "Failed to fetch"
      ? "Cannot connect to server. Please make sure the system is running."
      : err.message;
    showPopup(msg, false);
  });
}

function showPopup(message, success, bookingData) {
  document.getElementById("popupMessage").innerText = message;
  const qrSection = document.getElementById("qrSection");
  const qrImage = document.getElementById("qrImage");
  const qrTokenText = document.getElementById("qrTokenText");

  if (success && bookingData?.checkInToken && qrSection && qrImage && qrTokenText) {
    const qrPayload = bookingData.checkInToken;
    qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(qrPayload)}`;
    qrTokenText.innerText = `Check-in token: ${qrPayload}`;
    qrSection.style.display = "block";
  } else if (qrSection) {
    qrSection.style.display = "none";
  }

  document.getElementById("popup").style.display = "flex";
}

function closePopup() {
  document.getElementById("popup").style.display = "none";
}

// Load doctors on page load
window.onload = function() {
  loadDoctors();
  const queueList = document.getElementById("queueList");
  if (queueList) {
    loadQueue();
  }
};

function loadDoctors() {
  const select = document.getElementById("doctor");
  if (!select) return;

  // Keep time dropdown usable even if doctor API is slow/unavailable.
  buildDefaultTimeOptions();

  fetch("/api/doctors")
    .then(res => res.json())
    .then(data => {
      data.forEach(doctor => {
        const option = document.createElement("option");
        option.value = doctor.doctorId;
        option.textContent = doctor.name;
        select.appendChild(option);
      });
    })
    .catch(err => {
      console.error("Error loading doctors:", err);
      buildDefaultTimeOptions();
    });

}

function loadAvailableSlotsHint() {
  const doctorId = document.getElementById("doctor")?.value;
  const date = document.getElementById("date")?.value;
  const time = document.getElementById("time")?.value;
  const slotHint = document.getElementById("slotHint");

  if (!slotHint) return;
  slotHint.style.display = "none";

  if (!doctorId || !date) return;

  fetch(`/api/appointments/slots?doctor_id=${doctorId}&date=${date}`)
    .then(res => res.json())
    .then(data => {
      const slots = Array.isArray(data.slots) ? data.slots : [];

      if (slots.length === 0) {
        buildDefaultTimeOptions();
        slotHint.style.display = "block";
        slotHint.textContent = "No configured doctor schedule for this date. Showing default clinic time slots.";
        return;
      }

      setTimeOptionsFromSlots(slots);

      const availableSlots = slots.filter(slot => slot.available).length;
      slotHint.style.display = "block";

      if (!time) {
        slotHint.textContent = `${availableSlots} available slots for selected doctor/date.`;
        return;
      }

      const selected = slots.find(slot => slot.time === time.slice(0, 5));
      if (!selected) {
        slotHint.textContent = `${availableSlots} available slots. Selected time is outside clinic slot hours.`;
      } else if (!selected.available) {
        slotHint.textContent = `Selected time is already taken. Please choose another time.`;
      } else {
        slotHint.textContent = `Great! Selected slot is available.`;
      }
    })
    .catch(() => {
      buildDefaultTimeOptions();
      slotHint.style.display = "block";
      slotHint.textContent = "Unable to check slot availability right now. Showing default clinic time slots.";
    });
}

function buildDefaultTimeOptions() {
  const timeSelect = document.getElementById("time");
  if (!timeSelect || timeSelect.tagName !== "SELECT") return;

  const slots = [];
  for (let hour = 0; hour < 24; hour++) {
    slots.push({ time: `${String(hour).padStart(2, "0")}:00`, available: true });
    slots.push({ time: `${String(hour).padStart(2, "0")}:30`, available: true });
  }
  setTimeOptionsFromSlots(slots);
}

function setTimeOptionsFromSlots(slots) {
  const timeSelect = document.getElementById("time");
  if (!timeSelect || timeSelect.tagName !== "SELECT") return;

  const currentValue = timeSelect.value;
  timeSelect.innerHTML = `<option value="">Select Time</option>`;

  slots.forEach(slot => {
    const option = document.createElement("option");
    option.value = slot.time;
    option.textContent = slot.available ? slot.time : `${slot.time} (Booked)`;
    option.disabled = !slot.available;
    timeSelect.appendChild(option);
  });

  if (currentValue && [...timeSelect.options].some(opt => opt.value === currentValue && !opt.disabled)) {
    timeSelect.value = currentValue;
  }
}

function loadQueue() {
  const queueList = document.getElementById("queueList");
  if (!queueList) return;

  fetch("/api/queue")
    .then(res => res.json())
    .then(data => {
      queueList.innerHTML = "";
      data.forEach(q => {
        queueList.innerHTML += `<li>Queue ${q.queue_number} - ${q.patient_name}</li>`;
      });
    })
    .catch(err => console.error("Error loading queue:", err));
}

// Professional select behavior: allow mouse wheel to move options up/down.
function enableSelectWheelSupport() {
  const allSelects = document.querySelectorAll("select");
  allSelects.forEach((select) => {
    select.addEventListener(
      "wheel",
      (event) => {
        if (document.activeElement !== select) return;
        event.preventDefault();

        const direction = event.deltaY > 0 ? 1 : -1;
        let newIndex = select.selectedIndex + direction;
        newIndex = Math.max(0, Math.min(select.options.length - 1, newIndex));

        // Skip disabled options while scrolling.
        while (select.options[newIndex] && select.options[newIndex].disabled) {
          newIndex += direction;
          if (newIndex < 0 || newIndex >= select.options.length) break;
        }

        if (newIndex >= 0 && newIndex < select.options.length && !select.options[newIndex].disabled) {
          select.selectedIndex = newIndex;
          select.dispatchEvent(new Event("change"));
        }
      },
      { passive: false }
    );
  });
}

document.addEventListener("DOMContentLoaded", () => {
  enableSelectWheelSupport();

  // Fallback queue auto-refresh when realtime socket is unavailable.
  const queueBody = document.getElementById("queueBody");
  if (queueBody && typeof io === "undefined") {
    setInterval(loadQueue, 5000);
  }
});
