const express = require("express");
const router = express.Router();
const db = require("../db");

// ── Rate limiter ──────────────────────────────────────────────────────────────
const ipBuckets = new Map();
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 1000;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = ipBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    ipBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return next();
  }
  if (bucket.count >= RATE_LIMIT) {
    return res.status(429).json({ message: "Too many requests. Please wait a moment." });
  }
  bucket.count++;
  return next();
}

// ── API key check ─────────────────────────────────────────────────────────────
function isApiKeyConfigured() {
  const key = process.env.ANTHROPIC_API_KEY || "";
  return key.startsWith("sk-ant") && key.length > 20;
}

// ── Rule-based knowledge base ─────────────────────────────────────────────────
const TOPICS = [
  {
    id: "emergency",
    keywords: ["emergency", "heart attack", "stroke", "unconscious", "faint", "collapse", "ambulance", "999", "911", "kecemasan", "pengsan", "can't breathe", "cannot breathe", "severe bleeding", "overdose"],
    weight: 10,
    response: () =>
      "⚠️ **This sounds like a medical emergency!**\n\nPlease call **999** immediately or go to the nearest hospital emergency department.\n\n**Do not wait** if you notice:\n• Chest pain or pressure\n• Difficulty breathing\n• Loss of consciousness\n• Severe or uncontrolled bleeding\n• Signs of stroke: face drooping, arm weakness, slurred speech\n\nYour safety is the top priority."
  },
  {
    id: "greeting",
    keywords: ["hello", "hi", "hey", "good morning", "good afternoon", "good evening", "helo", "hai", "apa khabar", "selamat pagi", "selamat"],
    weight: 5,
    response: () =>
      "Hello! I'm your Smart Clinic assistant. 😊\n\nI can help you with:\n• **Clinic** — booking appointments, QR check-in, queue, doctors\n• **Health** — symptoms, conditions, general health advice\n• **Medication** — common medicines, dosage, side effects\n\nHow can I help you today?"
  },
  {
    id: "thanks",
    keywords: ["thank", "thanks", "thank you", "terima kasih", "tq", "thx", "appreciate"],
    weight: 5,
    response: () =>
      "You're welcome! 😊 Feel free to ask if you have any more questions. Take care and stay healthy!"
  },
  {
    id: "fever",
    keywords: ["fever", "temperature", "high temp", "panas", "demam", "suhu tinggi", "febrile", "hot body", "body heat", "for fever", "medicine for fever", "fever medicine", "take for fever", "tablet for fever", "ubat demam", "treat fever", "reduce fever", "break fever"],
    weight: 4,
    response: () =>
      "**Fever (High Temperature)**\n\nA fever is a body temperature above **37.5°C (99.5°F)**.\n\n**Home care:**\n• Take **paracetamol** (500–1000 mg every 4–6 hours) — do not exceed 4g per day\n• Or take **ibuprofen** (200–400 mg every 6–8 hours) with food\n• Drink plenty of water and clear fluids\n• Rest in a cool room and wear light clothing\n• Apply a cool damp cloth on the forehead\n\n**See a doctor immediately if:**\n• Temperature exceeds **39.5°C (103°F)**\n• Fever lasts more than **3 days**\n• Accompanied by stiff neck, rash, or severe headache\n• Infant under 3 months has any fever\n• Difficulty breathing or extreme fatigue\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "headache",
    keywords: ["headache", "head pain", "migraine", "kepala sakit", "sakit kepala", "head ache", "throbbing head", "head hurts", "for headache", "medicine for headache", "headache medicine", "headache tablet", "headache relief"],
    weight: 4,
    response: () =>
      "**Headache**\n\n**Common causes:** tension, dehydration, lack of sleep, eye strain, stress, high blood pressure, or migraine.\n\n**Relief tips:**\n• Drink water — dehydration is a very common cause\n• Take **paracetamol** (500–1000 mg) or **ibuprofen** (400 mg)\n• Rest in a quiet, dark room\n• Apply a cold or warm compress to your head/neck\n• Avoid screens if eyes feel strained\n\n**Signs of a serious headache — see a doctor immediately:**\n• Sudden, very severe \"thunderclap\" headache\n• Headache with stiff neck or fever\n• Headache after a head injury\n• Headache with vision changes, confusion, or weakness\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "cold_flu",
    keywords: ["cold", "flu", "cough", "runny nose", "sore throat", "sneezing", "congestion", "batuk", "selsema", "sakit tekak", "blocked nose", "stuffy nose", "phlegm", "mucus", "cough medicine", "cough syrup", "for cough", "medicine for cough", "cold medicine", "flu medicine", "for sore throat"],
    weight: 4,
    response: () =>
      "**Cold & Flu**\n\n**Common symptoms:** runny nose, sore throat, cough, sneezing, mild fever, body aches.\n\n**Home treatment:**\n• Rest as much as possible\n• Stay hydrated — warm water, soup, herbal teas\n• Take **paracetamol** for fever or aches\n• Use saline nasal spray for a blocked nose\n• Gargle warm salt water for a sore throat\n• Honey and lemon in warm water soothes a cough\n• Use steam inhalation for congestion\n\n**See a doctor if:**\n• Symptoms worsen after 7–10 days\n• High fever (above 39°C) that doesn't reduce\n• Difficulty breathing or chest pain\n• Ear pain or severe headache\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "paracetamol",
    keywords: ["paracetamol", "panadol", "acetaminophen", "tylenol", "paracetamol dosage", "panadol dosage", "how much paracetamol"],
    weight: 4,
    response: () =>
      "**Paracetamol (Panadol / Acetaminophen)**\n\n**Uses:** Fever, headache, mild to moderate pain (toothache, muscle pain, cold symptoms).\n\n**Standard adult dosage:**\n• 500 mg – 1000 mg per dose\n• Every **4–6 hours** as needed\n• **Maximum: 4000 mg (4g) per day**\n\n**Important warnings:**\n• Do NOT exceed 4g/day — liver damage risk\n• Avoid alcohol while taking paracetamol\n• Check other medicines — many contain paracetamol already\n• Reduce dose if you have liver problems\n• Safe in pregnancy (consult doctor)\n\n**Children:** Use weight-based dosing — always follow the label or ask a pharmacist.\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "ibuprofen",
    keywords: ["ibuprofen", "advil", "brufen", "nurofen", "ibuprofen dosage", "anti-inflammatory", "nsaid"],
    weight: 4,
    response: () =>
      "**Ibuprofen (Brufen / Advil)**\n\n**Uses:** Pain relief, fever, inflammation (muscle pain, joint pain, period pain, headache, dental pain).\n\n**Standard adult dosage:**\n• 200 mg – 400 mg per dose\n• Every **6–8 hours** with food or milk\n• **Maximum: 1200 mg per day** (without prescription)\n\n**Important warnings:**\n• Always take **with food** to protect the stomach\n• Avoid if you have stomach ulcers, kidney disease, or heart problems\n• Not recommended in pregnancy (especially after 20 weeks)\n• Avoid if allergic to aspirin or NSAIDs\n• Do not give to children under 3 months without doctor advice\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "antibiotics",
    keywords: ["antibiotic", "amoxicillin", "amoxil", "augmentin", "azithromycin", "penicillin", "antibiotic course", "prescription", "antibiotik"],
    weight: 4,
    response: () =>
      "**Antibiotics**\n\nAntibiotics treat **bacterial infections only** — they do not work on viral infections like colds, flu, or most coughs.\n\n**Important rules:**\n• Always complete the full course, even if you feel better\n• Never share antibiotics or use leftover ones\n• Take at regular intervals (as prescribed)\n• Some antibiotics should be taken with food; others on an empty stomach — follow the label\n\n**Common antibiotics:**\n• **Amoxicillin** — infections of the ear, throat, chest, urinary tract\n• **Azithromycin** — respiratory infections, skin infections\n• **Metronidazole** — dental/gut infections (avoid alcohol)\n\n**Antibiotics require a doctor's prescription.** Please book an appointment at Smart Clinic if you think you need one.\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "antihistamine",
    keywords: ["antihistamine", "loratadine", "cetirizine", "clarityn", "zyrtec", "allergy tablet", "hay fever", "allergic reaction", "histamine"],
    weight: 4,
    response: () =>
      "**Antihistamines (Allergy Tablets)**\n\n**Uses:** Allergic rhinitis (hay fever), hives/rash, itchy eyes, insect bites, allergic reactions.\n\n**Common types:**\n• **Cetirizine (Zyrtec)** — once daily, may cause mild drowsiness\n• **Loratadine (Clarityn)** — once daily, non-drowsy\n• **Chlorphenamine** — older type, causes drowsiness, often used for sleep/itch\n\n**General dosage:** Follow package instructions. Most are once daily for adults.\n\n**Warnings:**\n• Drowsy types — do not drive or operate machinery\n• Consult a doctor before use if pregnant or breastfeeding\n• Seek emergency help if you have anaphylaxis (severe reaction with swelling of face/throat)\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "stomach",
    keywords: ["stomachache", "stomach pain", "stomach ache", "nausea", "vomit", "vomiting", "gastric", "perut sakit", "sakit perut", "mual", "muntah", "indigestion", "heartburn", "acid reflux", "stomach medicine", "medicine for nausea", "medicine for vomiting", "for stomach", "stomach ache medicine", "gastric medicine"],
    weight: 4,
    response: () =>
      "**Stomach Pain / Nausea / Vomiting**\n\n**Common causes:** Indigestion, gastritis, food poisoning, stress, or viral infection.\n\n**Home care:**\n• Rest and avoid solid food for a few hours if vomiting\n• Sip small amounts of water, clear broth, or sports drinks to stay hydrated\n• Try plain foods once feeling better: rice, bread, banana, crackers (BRAT diet)\n• Avoid spicy, fatty, or dairy foods\n• **Antacids** (e.g., Gaviscon, Eno) can relieve heartburn/indigestion\n\n**See a doctor if:**\n• Vomiting blood or dark material\n• Severe or persistent stomach pain\n• Signs of dehydration (no urination, very dry mouth)\n• Pain with fever lasting more than 24 hours\n• Yellowing of skin or eyes\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "diarrhea",
    keywords: ["diarrhea", "diarrhoea", "loose stool", "watery stool", "frequent toilet", "cirit birit", "cirit", "running stomach", "loose motion"],
    weight: 3,
    response: () =>
      "**Diarrhea**\n\n**Most important step:** Stay hydrated. Diarrhea causes rapid fluid loss.\n\n**Home care:**\n• Drink **oral rehydration salts (ORS)** — available at any pharmacy\n• Sip water, diluted juice, or clear broth frequently\n• Eat plain, easy foods: rice, bananas, toast, plain crackers\n• Avoid dairy, fatty foods, caffeine, and alcohol\n• **Loperamide (Imodium)** can slow diarrhea in adults (not for children under 12)\n\n**See a doctor if:**\n• Diarrhea lasts more than **48 hours**\n• Blood or mucus in the stool\n• Signs of dehydration: dizziness, dark urine, dry mouth\n• High fever (above 38.5°C)\n• Recently traveled abroad\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "constipation",
    keywords: ["constipation", "cannot poo", "cannot poop", "hard stool", "sembelit", "bowel movement", "no bowel"],
    weight: 3,
    response: () =>
      "**Constipation**\n\nConstipation is having fewer than 3 bowel movements per week, or stools that are hard and difficult to pass.\n\n**Home care:**\n• Drink **at least 8 glasses of water** per day\n• Eat more **fibre**: fruits, vegetables, whole grains, oats\n• Stay physically active — even a short walk helps\n• Do not ignore the urge to go to the toilet\n• **Laxatives** (e.g., lactulose, Dulcolax) can help short-term\n\n**See a doctor if:**\n• Constipation lasts more than 3 weeks\n• Blood in the stool\n• Severe abdominal pain\n• Unexplained weight loss\n• Sudden change in bowel habits after age 50\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "blood_pressure",
    keywords: ["blood pressure", "hypertension", "high blood", "low blood pressure", "bp", "darah tinggi", "darah rendah", "hypotension", "bp reading", "systolic", "diastolic", "medicine for blood pressure", "blood pressure medicine", "for hypertension", "lower blood pressure"],
    weight: 4,
    response: () =>
      "**Blood Pressure**\n\n**Normal:** Below 120/80 mmHg\n**High (Hypertension):** 140/90 mmHg or above\n**Low (Hypotension):** Below 90/60 mmHg\n\n**Managing high blood pressure:**\n• Reduce salt intake\n• Exercise regularly (30 min, 5 days/week)\n• Maintain a healthy weight\n• Limit alcohol and quit smoking\n• Manage stress\n• Take prescribed medication consistently — do not stop without doctor's advice\n\n**Symptoms of a hypertensive crisis (very high BP) — seek emergency care:**\n• Severe headache, blurred vision, chest pain, difficulty breathing\n\n**Low blood pressure symptoms:** Dizziness, fainting, cold/pale skin — drink more fluids and sit/lie down.\n\nBook an appointment to have your blood pressure checked at Smart Clinic.\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "diabetes",
    keywords: ["diabetes", "blood sugar", "glucose", "diabetic", "kencing manis", "insulin", "metformin", "sugar level", "hba1c", "type 1", "type 2", "diabetes medicine", "medicine for diabetes", "lower blood sugar", "control sugar"],
    weight: 4,
    response: () =>
      "**Diabetes**\n\n**Types:**\n• **Type 1** — immune system destroys insulin-producing cells; requires daily insulin\n• **Type 2** — body doesn't use insulin well; most common type; lifestyle-related\n\n**Warning signs:** Frequent urination, excessive thirst, unexplained weight loss, blurred vision, slow-healing wounds, fatigue.\n\n**Managing Type 2 diabetes:**\n• Eat a balanced, low-sugar diet\n• Exercise regularly\n• Monitor blood sugar levels\n• Take prescribed medication (e.g., Metformin)\n• Attend regular check-ups\n\n**Normal blood sugar (fasting):** 4.0–6.0 mmol/L\n**Diabetic range (fasting):** 7.0 mmol/L or above\n\n**Low blood sugar (hypoglycemia):** Shakiness, sweating, confusion — eat/drink something sugary immediately.\n\nIf you haven't been diagnosed but notice symptoms, please book an appointment for a blood test.\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "asthma",
    keywords: ["asthma", "inhaler", "wheeze", "wheezing", "shortness of breath", "sesak nafas", "breathing difficulty", "bronchial", "salbutamol", "ventolin"],
    weight: 3,
    response: () =>
      "**Asthma**\n\nAsthma causes the airways to narrow, leading to wheezing, coughing, chest tightness, and shortness of breath.\n\n**During an asthma attack:**\n• Use your **reliever inhaler** (blue — salbutamol/Ventolin): 1–2 puffs every 30–60 seconds, up to 10 puffs\n• Sit upright, breathe slowly and calmly\n• Call **999** if no improvement after 10 puffs or condition worsens\n\n**Managing asthma:**\n• Always carry your reliever inhaler\n• Use your preventer inhaler (brown/orange) daily as prescribed\n• Avoid triggers: dust, smoke, pet dander, cold air, exercise (when uncontrolled)\n• Have a written asthma action plan from your doctor\n\n**See a doctor if attacks are becoming more frequent or severe.**\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "allergy_rash",
    keywords: ["rash", "hives", "itch", "itchy", "gatal", "skin reaction", "allergic rash", "red skin", "swollen skin", "eczema", "dermatitis", "urticaria"],
    weight: 3,
    response: () =>
      "**Skin Rash / Allergic Reaction**\n\n**Common causes:** Allergies (food, medication, plants), insect bites, heat rash, eczema, viral infection.\n\n**Home care:**\n• Apply a **cool damp cloth** to soothe itching\n• Take an **antihistamine** (cetirizine or loratadine) for itch relief\n• Use **calamine lotion** or hydrocortisone cream on mild rashes\n• Avoid scratching — it worsens the rash and risks infection\n• Avoid the suspected trigger\n\n**Go to the doctor or emergency immediately if:**\n• Rash with swelling of face, lips, or throat\n• Difficulty breathing (signs of anaphylaxis)\n• Rash spreading rapidly over the body\n• Blisters or rash with high fever\n• Rash after starting a new medication\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "back_pain",
    keywords: ["back pain", "backache", "sakit belakang", "lower back", "spine", "lumbar", "back ache", "upper back", "slipped disc", "sciatica"],
    weight: 3,
    response: () =>
      "**Back Pain**\n\nBack pain is very common and usually improves within a few weeks.\n\n**Home care:**\n• Take **ibuprofen** (400 mg with food) or **paracetamol** (1000 mg) for pain\n• Apply a heat pack or ice pack to the affected area\n• Stay as active as you can — rest is not recommended beyond 1–2 days\n• Try gentle stretching and walking\n• Check your posture — especially when sitting or lifting\n\n**See a doctor if:**\n• Pain is severe or getting worse\n• Pain radiates down the leg (possible sciatica)\n• Numbness, tingling, or weakness in the legs\n• Pain following an injury or fall\n• Pain associated with bladder/bowel problems\n• Pain that wakes you from sleep\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "chest_pain",
    keywords: ["chest pain", "chest tightness", "sakit dada", "heart pain", "heart ache", "palpitation", "chest pressure", "angina", "heart"],
    weight: 5,
    response: () =>
      "⚠️ **Chest Pain — Take Seriously**\n\nChest pain can have many causes — some minor, some life-threatening.\n\n**Call 999 immediately if chest pain is:**\n• Crushing, squeezing, or pressure-like\n• Spreading to the arm, jaw, neck, or back\n• Accompanied by shortness of breath, sweating, nausea\n• Sudden and severe\n\nThese may be signs of a **heart attack**.\n\n**Less urgent causes** (still see a doctor):\n• Acid reflux / heartburn — burning sensation after eating\n• Muscle strain — pain that worsens with movement\n• Anxiety/panic attack — racing heart, tingling\n• Pleurisy — sharp pain when breathing deeply\n\n**When in doubt, always seek medical attention promptly.**\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "dizziness",
    keywords: ["dizzy", "dizziness", "vertigo", "pening", "lightheaded", "off balance", "room spinning", "faint", "spinning"],
    weight: 3,
    response: () =>
      "**Dizziness / Vertigo**\n\n**Common causes:** Dehydration, low blood pressure, inner ear problem (vertigo), low blood sugar, anaemia, or anxiety.\n\n**Immediate relief:**\n• Sit or lie down safely to avoid falling\n• Drink water — especially if you haven't had enough fluids\n• Eat something if you may have low blood sugar\n• Avoid sudden movements\n\n**For vertigo (room spinning):** The Epley manoeuvre may help BPPV — ask your doctor to demonstrate it.\n\n**See a doctor if:**\n• Dizziness is severe or recurrent\n• Accompanied by hearing loss or tinnitus (ringing in ears)\n• Chest pain, shortness of breath, or palpitations\n• Dizziness after a head injury\n• Sudden onset with numbness, vision changes, or slurred speech (possible stroke)\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "fatigue",
    keywords: ["tired", "fatigue", "exhausted", "penat", "lelah", "no energy", "always tired", "feeling weak", "weakness", "lethargic", "lethargy"],
    weight: 3,
    response: () =>
      "**Fatigue / Tiredness**\n\n**Common causes:** Lack of sleep, stress, poor diet, anaemia, thyroid problems, diabetes, depression, or infection.\n\n**General advice:**\n• Aim for **7–9 hours of sleep** per night\n• Stay hydrated and eat regular balanced meals\n• Exercise regularly — even a short daily walk helps\n• Reduce stress and screen time before bed\n• Limit caffeine and alcohol\n\n**See a doctor if:**\n• Fatigue lasts more than 2 weeks without clear cause\n• Accompanied by weight loss, night sweats, or swollen glands\n• Severe tiredness affecting daily life\n• Other symptoms such as pale skin, feeling cold, or shortness of breath\n\nA blood test at Smart Clinic can check for common causes like anaemia, thyroid issues, or diabetes.\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "sleep",
    keywords: ["sleep", "insomnia", "cannot sleep", "tidur", "sleepless", "sleep problem", "sleep disorder", "trouble sleeping", "wake up at night", "oversleeping"],
    weight: 3,
    response: () =>
      "**Sleep Problems / Insomnia**\n\n**Good sleep hygiene tips:**\n• Keep a consistent sleep schedule (same time every day)\n• Avoid screens (phone, TV) 1 hour before bed\n• Keep the bedroom cool, dark, and quiet\n• Avoid caffeine after 2pm\n• Avoid heavy meals close to bedtime\n• Exercise regularly — but not close to bedtime\n• Try relaxation techniques: deep breathing, meditation\n\n**Short-term sleep aids:**\n• **Antihistamines** with sedating effects (e.g., diphenhydramine) for occasional use\n• Melatonin supplements — low dose, taken 30 min before bed\n\n**See a doctor if:**\n• Insomnia lasts more than 3 weeks\n• You snore loudly or stop breathing while sleeping (sleep apnoea)\n• Tiredness seriously affects daily life\n• You need sleeping tablets regularly\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "anxiety_stress",
    keywords: ["anxiety", "stress", "anxious", "panic", "panic attack", "mental health", "depression", "tekanan", "mental", "nervous", "worry", "worried", "sad", "mood", "emotional"],
    weight: 3,
    response: () =>
      "**Stress, Anxiety & Mental Health**\n\nMental health is just as important as physical health. It's okay to ask for help.\n\n**Self-care tips:**\n• Talk to someone you trust about how you're feeling\n• Exercise regularly — it's one of the best natural mood boosters\n• Practice deep breathing: inhale for 4s, hold 4s, exhale 4s\n• Limit alcohol and avoid recreational drugs\n• Maintain a daily routine and sleep schedule\n• Reduce social media and news consumption if they increase anxiety\n\n**For a panic attack:**\n• Breathe slowly and deeply\n• Focus on what you can see, hear, and touch (grounding technique)\n• Remind yourself: \"This will pass. I am safe.\"\n\n**Please see a doctor if:**\n• Feelings of anxiety or sadness are persistent (more than 2 weeks)\n• You are having thoughts of harming yourself\n• Daily life is significantly affected\n\nYou can book an appointment at Smart Clinic to speak with a doctor about mental health support.\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "vitamins",
    keywords: ["vitamin", "supplement", "zinc", "iron", "calcium", "vitamin c", "vitamin d", "omega", "multivitamin", "supplement dosage"],
    weight: 3,
    response: () =>
      "**Vitamins & Supplements**\n\n**Common vitamins and their uses:**\n• **Vitamin C** — immune support, antioxidant; 500–1000 mg/day\n• **Vitamin D** — bone health, immunity; 400–2000 IU/day (deficiency is common in Malaysia)\n• **Iron** — for anaemia/fatigue; take on an empty stomach with Vitamin C for better absorption\n• **Calcium** — bone health; 500–1000 mg/day (best taken with Vitamin D)\n• **Zinc** — immune function, wound healing; 8–11 mg/day\n• **Omega-3 (fish oil)** — heart health, brain function; 1000 mg/day\n• **Folic acid** — essential before and during pregnancy; 400 mcg/day\n\n**Tips:**\n• Most people get enough vitamins from a balanced diet\n• Do not mega-dose without medical advice\n• Some supplements interact with medications\n• Consult a pharmacist or doctor before starting new supplements\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "covid",
    keywords: ["covid", "coronavirus", "covid-19", "omicron", "pcr test", "antigen test", "positive test", "isolation", "quarantine", "covid symptoms"],
    weight: 3,
    response: () =>
      "**COVID-19**\n\n**Common symptoms:** Fever, cough, sore throat, runny nose, fatigue, loss of taste/smell, body aches.\n\n**If you test positive:**\n• Rest at home and stay hydrated\n• Take paracetamol for fever and aches\n• Wear a mask around others in your household\n• Monitor your oxygen level if you have a pulse oximeter (normal: above 95%)\n• Follow the latest Ministry of Health Malaysia guidelines on isolation\n\n**Seek urgent medical care if:**\n• Difficulty breathing or chest pain\n• Oxygen saturation drops below 94%\n• Confusion or inability to stay awake\n• Lips or face turning blue\n\n**High-risk groups** (elderly, diabetic, immunocompromised) should contact a doctor early when testing positive.\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "appointment",
    keywords: ["book", "appointment", "schedule", "booking", "temujanji", "make appointment", "how to book", "reserve", "register"],
    weight: 4,
    response: (doctors) =>
      `**Booking an Appointment**\n\nYou can book an appointment at Smart Clinic in two simple steps:\n\n1. Click **\"Book Appointment\"** in the navigation bar above\n2. Fill in your details: name, IC number, doctor, date, and time\n\nAfter booking, you will receive a **QR code token** for check-in on the day of your appointment.\n\n**Available doctors:**\n${doctors}\n\n*Need help? Contact the clinic directly for assistance.*`
  },
  {
    id: "checkin",
    keywords: ["check in", "check-in", "qr code", "qr token", "token", "scan", "checkin", "how to check in", "confirm attendance"],
    weight: 4,
    response: () =>
      "**QR Check-In**\n\nWhen you arrive at the clinic on your appointment day:\n\n1. Open the **Check-In page** from the navigation bar\n2. Enter the **QR token** from your booking confirmation (or scan the QR code)\n3. Your attendance will be confirmed and you will be added to the queue\n\n**Your token was sent** via the booking confirmation page when you made your appointment. Check your QR code or use the token number from your confirmation.\n\nIf you lose your token, contact the clinic reception for assistance."
  },
  {
    id: "queue",
    keywords: ["queue", "wait", "waiting time", "my turn", "giliran", "position", "how long", "queue number", "queue status", "live queue"],
    weight: 4,
    response: () =>
      "**Queue & Waiting Time**\n\nYou can check the live queue status at any time:\n\n1. Click **\"Queue\"** in the navigation bar\n2. You will see all patients currently in today's queue, their status (Waiting / In Progress / Completed), and estimated waiting times\n\n**Queue number** is assigned when you check in with your QR token.\n\nEstimated waiting times are updated automatically based on how long consultations are taking. The queue page refreshes every few seconds so you always see the latest status."
  },
  {
    id: "doctors",
    keywords: ["doctor", "specialist", "doktor", "available doctor", "which doctor", "see a doctor", "physician", "dr."],
    weight: 4,
    response: (doctors) =>
      `**Our Doctors**\n\nSmart Clinic currently has the following doctors available:\n\n${doctors}\n\nTo book an appointment with a specific doctor, click **\"Book Appointment\"** in the navigation bar and select your preferred doctor from the dropdown.\n\nIf you need a specialist referral, our general practitioners can advise you.`
  },
  {
    id: "pain_general",
    keywords: ["pain", "ache", "hurt", "hurts", "sakit", "painful", "sore", "tender", "cramp"],
    weight: 1,
    response: () =>
      "**Pain Relief — General Advice**\n\n**Over-the-counter options:**\n• **Paracetamol** (500–1000 mg) — mild to moderate pain, safe for most people\n• **Ibuprofen** (200–400 mg with food) — pain with inflammation (muscle, joint, dental)\n\n**General tips:**\n• Rest the affected area if possible\n• Apply ice (first 48 hours) or heat (after 48 hours) depending on the type of pain\n• Gentle stretching can help muscle pain\n\n**See a doctor if:**\n• Pain is severe, worsening, or unexplained\n• Pain following an injury\n• Pain with other concerning symptoms\n• Pain that doesn't improve with standard pain relief\n\nCould you tell me more about where the pain is? I can give more specific advice.\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "eye",
    keywords: ["eye", "vision", "mata", "red eye", "eye pain", "blurry vision", "conjunctivitis", "eye infection", "eye drop", "sore eye"],
    weight: 3,
    response: () =>
      "**Eye Problems**\n\n**Red / irritated eyes (conjunctivitis):**\n• Bacterial: yellow/green discharge — requires antibiotic eye drops (see a doctor)\n• Viral: watery, pink — usually clears on its own in 1–2 weeks\n• Allergic: itchy, watery — antihistamine eye drops can help\n\n**General eye care:**\n• Do not rub your eyes\n• Wash hands frequently\n• Use clean tissues to wipe discharge from corner of eye (outward)\n• Saline eye drops can relieve irritation\n\n**See a doctor immediately if:**\n• Sudden severe eye pain or loss of vision\n• Eye injury or chemical splash (rinse with water first, then go to A&E)\n• Sensitivity to light with severe headache\n• White or cloudy spot on the cornea\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "dental",
    keywords: ["toothache", "tooth pain", "dental", "tooth ache", "gum", "cavity", "gigi", "sakit gigi", "dentist", "wisdom tooth"],
    weight: 3,
    response: () =>
      "**Toothache / Dental Pain**\n\n**Immediate relief:**\n• Take **paracetamol** (1000 mg) or **ibuprofen** (400 mg with food) for pain\n• Rinse with warm salt water\n• Clove oil (eugenol) applied to the tooth can temporarily numb pain\n• Avoid very hot, cold, or sweet foods\n\n**You need to see a dentist for:**\n• Persistent or severe toothache\n• Swollen face, jaw, or gum\n• Knocked-out or cracked tooth\n• Abscess (throbbing pain, fever, foul taste)\n\n**Smart Clinic can refer you** to a dental service if needed. Book an appointment through our website.\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "weight_diet",
    keywords: ["weight", "obesity", "bmi", "lose weight", "weight loss", "overweight", "fat", "diet plan", "calories", "nutrition", "healthy eating", "slim", "kurus", "gemuk", "diet", "underweight", "gain weight"],
    weight: 3,
    response: () =>
      "**Weight Management & Healthy Diet**\n\nMaintaining a healthy weight reduces the risk of diabetes, heart disease, and joint problems.\n\n**Healthy weight loss tips:**\n• Aim to lose **0.5–1 kg per week** — slow and steady is sustainable\n• Eat more vegetables, fruits, whole grains, and lean protein\n• Reduce sugar, white rice, white bread, and processed foods\n• Drink water before meals to feel fuller\n• Do at least **150 minutes of moderate exercise per week**\n• Avoid skipping meals — it often leads to overeating later\n\n**BMI guide (adults):**\n• Below 18.5 → Underweight\n• 18.5–24.9 → Normal weight\n• 25–29.9 → Overweight\n• 30 and above → Obese\n\nFor a personalised weight management plan, book a consultation at Smart Clinic.\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "period_womens",
    keywords: ["period", "menstruation", "menstrual", "menstrual cramps", "pms", "pcos", "irregular period", "heavy bleeding", "period pain", "haid", "datang bulan", "womens health", "women health", "vaginal", "ovulation"],
    weight: 4,
    response: () =>
      "**Menstrual Health & Period Problems**\n\n**Menstrual cramp relief:**\n• Take **ibuprofen** (400 mg with food) — works better than paracetamol for period pain\n• Apply a heat pack to the lower abdomen\n• Light exercise (walking, yoga) can help\n• Stay hydrated and reduce salt and caffeine\n\n**Normal vs. see a doctor:**\n• Normal: mild to moderate cramps, cycle length 21–35 days\n• See a doctor if: severe pain that stops daily activities, very heavy bleeding (soaking a pad every hour), cycle shorter than 21 days or longer than 35 days, periods stopping for more than 3 months\n\n**PCOS (Polycystic Ovary Syndrome):** irregular periods, acne, excess hair growth, weight gain — requires blood tests and doctor assessment.\n\nFor any persistent menstrual concerns, book an appointment at Smart Clinic.\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "kidney_uti",
    keywords: ["kidney", "urinary tract", "uti", "urination", "bladder", "frequent urination", "painful urination", "burning urination", "kidney stone", "sakit kencing", "kidney pain", "flank pain", "renal", "urine", "cloudy urine"],
    weight: 4,
    response: () =>
      "**Urinary Tract & Kidney Health**\n\n**UTI symptoms:** Burning or pain when urinating, frequent urge to urinate, cloudy or dark urine, lower abdominal discomfort.\n\n**Home care:**\n• Drink plenty of water (2–3 litres/day)\n• Urinate frequently — don't hold it in\n• Wipe front to back (women)\n\n⚠️ **UTIs require antibiotic treatment** — please see a doctor for a prescription.\n\n**Kidney stones:** Severe back or flank pain (comes in waves), blood in urine, nausea, painful urination. Requires medical evaluation.\n\n**Seek immediate care for:**\n• Severe pain with fever and chills (possible kidney infection)\n• Blood in urine\n• No urination for more than 8 hours\n\n**Kidney health tips:**\n• Drink adequate water daily\n• Reduce excessive salt and protein\n• Control blood pressure and blood sugar\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "wound_firstaid",
    keywords: ["wound", "cut", "bruise", "injury", "bleeding", "first aid", "burn", "bandage", "sprain", "fracture", "broken bone", "scrape", "blister", "swollen", "twisted ankle", "luka", "terluka", "terpotong"],
    weight: 3,
    response: () =>
      "**Wound Care & First Aid**\n\n**For cuts and wounds:**\n• Apply gentle pressure with a clean cloth to stop bleeding\n• Rinse under clean running water for 5–10 minutes\n• Apply antiseptic cream (e.g., Betadine, Savlon)\n• Cover with a sterile bandage and change daily\n\n**For burns:**\n• Cool under cold running water for at least **10 minutes**\n• Do NOT use ice, butter, or toothpaste\n• Cover loosely with a clean cloth\n• See a doctor for burns larger than a palm or on the face/hands\n\n**For sprains (twisted ankle/wrist) — RICE method:**\n• **R**est, **I**ce (20 min on/off), **C**ompression (bandage), **E**levation\n• Take ibuprofen for pain and swelling\n\n**See a doctor for:**\n• Deep wounds that won't stop bleeding\n• Signs of infection: spreading redness, warmth, pus, fever\n• Possible fracture or animal/human bite\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "heart_cholesterol",
    keywords: ["heart", "cardiac", "cholesterol", "triglyceride", "ecg", "heart rate", "pulse", "artery", "cardiovascular", "heart failure", "heart disease", "kolesterol", "jantung", "high cholesterol", "heart attack"],
    weight: 4,
    response: () =>
      "**Heart Health & Cholesterol**\n\n**Healthy cholesterol levels:**\n• Total cholesterol: below **5.2 mmol/L**\n• LDL (\"bad\" cholesterol): below **3.4 mmol/L**\n• HDL (\"good\" cholesterol): above **1.0 mmol/L** (men), **1.3** (women)\n\n**Improving heart health:**\n• Eat more fruits, vegetables, oily fish, and whole grains\n• Reduce saturated fat (fried food, fatty meat, full-fat dairy)\n• Exercise regularly — at least 150 minutes/week\n• Quit smoking and limit alcohol\n• Control blood pressure and blood sugar\n\n**Warning signs — see a doctor promptly:**\n• Chest pain, tightness, or pressure\n• Shortness of breath at rest or mild activity\n• Swollen ankles or legs\n• Racing or irregular heartbeat\n\n⚠️ **Call 999 for sudden severe chest pain — may be a heart attack.**\n\nBook a health screening at Smart Clinic to check your heart risk and cholesterol.\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "pregnancy",
    keywords: ["pregnant", "pregnancy", "prenatal", "morning sickness", "trimester", "antenatal", "folic acid", "miscarriage", "labour", "delivery", "contractions", "breastfeed", "postnatal", "hamil", "ibu mengandung"],
    weight: 4,
    response: () =>
      "**Pregnancy Health**\n\n**Early pregnancy tips:**\n• Take **folic acid** (400 mcg/day) — ideally before conception and for the first 12 weeks\n• Avoid alcohol, smoking, and raw/undercooked foods\n• Take a prenatal vitamin as recommended by your doctor\n• Attend all antenatal check-ups\n\n**Morning sickness relief:**\n• Eat small, frequent meals; avoid spicy and fatty foods\n• Try ginger tea or ginger biscuits\n• Stay hydrated with small sips\n• Vitamin B6 may help — ask your doctor\n\n**Safe medications in pregnancy:**\n• **Paracetamol** — generally safe for pain/fever\n• **Avoid ibuprofen** (especially after 20 weeks)\n• Never self-medicate without doctor approval\n\n**See a doctor immediately if:**\n• Heavy vaginal bleeding\n• Severe abdominal pain or fever\n• Severe headache, vision changes, or facial swelling (pre-eclampsia)\n• Reduced baby movement after 28 weeks\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "children_health",
    keywords: ["child", "baby", "infant", "toddler", "kids", "pediatric", "vaccination", "immunization", "growth", "kanak-kanak", "budak", "bayi", "fever child", "child fever", "vaccine", "growth chart"],
    weight: 4,
    response: () =>
      "**Children's Health**\n\n**Vaccinations (Malaysia immunisation schedule):**\n• 0–2 months: Hepatitis B, BCG\n• 2–6 months: DTaP, IPV, Hib, Hepatitis B, Pneumococcal\n• 12–18 months: MMR, Varicella\n• Follow the KKM (Ministry of Health Malaysia) schedule for full protection\n\n**Child fever:**\n• Under 3 months with any fever → see a doctor immediately\n• 3 months and older: paracetamol syrup (15 mg/kg per dose) every 4–6 hours\n• Keep child hydrated; dress lightly; use cool damp cloth\n• See a doctor if fever exceeds 39.5°C or lasts more than 3 days\n\n**Take a sick child to the doctor immediately if:**\n• Difficulty breathing\n• Unusual drowsiness or cannot be woken\n• Not drinking/eating for extended periods\n• Rash with fever or febrile seizures\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "skin_hair",
    keywords: ["acne", "pimple", "skin care", "dry skin", "oily skin", "hair loss", "dandruff", "eczema", "psoriasis", "sunburn", "dark spots", "pigmentation", "jerawat", "kulit", "rambut gugur", "rash skin"],
    weight: 3,
    response: () =>
      "**Skin & Hair Health**\n\n**Acne care:**\n• Wash face twice daily with a gentle cleanser\n• Use oil-free, non-comedogenic moisturiser and sunscreen\n• Don't squeeze pimples — spreads bacteria and causes scarring\n• Benzoyl peroxide or salicylic acid products can help mild acne\n• For moderate/severe acne, see a doctor for prescription treatment\n\n**Dry skin:**\n• Moisturise immediately after showering while skin is damp\n• Use fragrance-free, gentle moisturisers\n• Use lukewarm (not hot) water when bathing\n\n**Hair loss:**\n• Some daily shedding (50–100 hairs) is normal\n• Causes: stress, nutritional deficiency (iron, biotin, protein), thyroid issues, hormonal changes\n• Blood tests can identify underlying causes\n• See a doctor if hair loss is sudden, significant, or patchy\n\n**Eczema:**\n• Moisturise regularly with thick, fragrance-free cream\n• Avoid triggers: harsh soaps, synthetic fabrics\n• Hydrocortisone cream for mild flares\n\n*This is general information only — always consult your doctor for personal medical advice.*"
  },
  {
    id: "medication_general",
    keywords: ["medicine", "medication", "drug", "ubat", "pill", "tablet", "capsule", "what medicine", "which medicine", "take medicine"],
    weight: 1,
    response: () =>
      "I can help with information about specific medications. Please tell me the name of the medicine you're asking about, or describe your symptoms and I can suggest what's commonly used.\n\n**Common medications I can explain:**\n• Paracetamol (Panadol) — fever and pain\n• Ibuprofen (Brufen) — pain and inflammation\n• Antibiotics (Amoxicillin, Azithromycin)\n• Antihistamines (Loratadine, Cetirizine)\n• Antacids / Omeprazole — stomach/acid\n• Loperamide (Imodium) — diarrhea\n• Metformin — diabetes\n• Salbutamol inhaler — asthma\n\nWhat would you like to know more about?"
  }
];

// Short keywords (≤3 chars) use word-boundary matching to avoid false positives
// e.g. "hi" must not match "think" or "child"
function kwMatch(text, kw) {
  if (kw.length <= 3) {
    return new RegExp("\\b" + kw + "\\b").test(text);
  }
  return text.includes(kw);
}

// ── Score and pick best matching topic ───────────────────────────────────────
function findBestReply(userText, doctorListText) {
  const text = userText.toLowerCase();

  // Check for very short/empty messages
  if (text.trim().length < 2) {
    return "Could you please tell me more about what you need help with?";
  }

  let best = null;
  let bestScore = 0;

  for (const topic of TOPICS) {
    let score = 0;
    for (const kw of topic.keywords) {
      if (kwMatch(text, kw)) {
        score += topic.weight || 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = topic;
    }
  }

  if (!best || bestScore === 0) {
    return (
      "I'd be happy to help with your health question! Here are the topics I can answer:\n\n" +
      "**Symptoms & Conditions:** Fever, headache, cold/flu, cough, stomach pain, diarrhea, dizziness, chest pain, back pain, eye problems, dental pain, skin/hair issues\n\n" +
      "**Health Conditions:** Diabetes, high blood pressure, asthma, heart & cholesterol, kidney/UTI, allergies\n\n" +
      "**Medications:** Paracetamol, ibuprofen, antibiotics, antihistamines, vitamins & supplements\n\n" +
      "**Other Health Topics:** Weight management, women's health & periods, pregnancy, children's health, wound/first aid, COVID-19, mental health & stress\n\n" +
      "**Clinic:** Booking appointments, QR check-in, queue status, our available doctors\n\n" +
      "Could you rephrase your question or describe your symptoms? I'll do my best to help!"
    );
  }

  const doctorList =
    doctorListText ||
    "• Please contact the clinic for the current list of available doctors";

  return typeof best.response === "function"
    ? best.response(doctorList)
    : best.response;
}

// ── Route handler ─────────────────────────────────────────────────────────────
router.post("/", rateLimit, async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ message: "messages array is required" });
    }

    for (const msg of messages) {
      if (!msg.role || typeof msg.content !== "string") {
        return res.status(400).json({ message: "Each message must have role and content" });
      }
      if (!["user", "assistant"].includes(msg.role)) {
        return res.status(400).json({ message: `Invalid role: ${msg.role}` });
      }
    }

    const trimmedMessages = messages.slice(-20);

    // Fetch live doctors list — non-fatal, chatbot works without it
    let doctorListText = null;
    try {
      const doctors = await db.queryAsync(
        "SELECT name, specialization FROM doctors ORDER BY name ASC"
      );
      if (doctors.length > 0) {
        doctorListText = doctors.map(d => `• ${d.name} — ${d.specialization}`).join("\n");
      }
    } catch (_dbErr) {
      // DB unavailable — continue with rule-based engine without doctor list
    }

    // Use Claude AI if API key is properly configured
    if (isApiKeyConfigured()) {
      const Anthropic = require("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const systemPrompt = `You are a friendly and helpful patient assistant for Smart Clinic. You help patients with questions about the clinic, general health information, and medications.

CLINIC INFORMATION:
• Services: General consultation, follow-up visits, specialist referrals
• Appointment booking: Available on the appointment page of this website
• Check-in: Patients use their QR token at the check-in page
• Queue: Patients can view their queue position on the live queue page

AVAILABLE DOCTORS:
${doctorListText || "• Please contact the clinic for the current list of doctors"}

RULES:
• Always recommend consulting a doctor for specific medical concerns, diagnosis, or treatment
• Never diagnose conditions or prescribe medications
• For urgent or severe symptoms, strongly advise seeking immediate medical attention or calling emergency services (999)
• Keep responses friendly, concise, and easy to understand
• When providing health or medication information, add: "This is general information only — always consult your doctor for personal medical advice."`;

      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: systemPrompt,
        messages: trimmedMessages
      });

      const reply = response.content[0]?.text || "I'm sorry, I was unable to generate a response. Please try again.";
      return res.json({ reply });
    }

    // ── Fallback: rule-based engine ───────────────────────────────────────────
    const lastUserMsg = [...trimmedMessages].reverse().find(m => m.role === "user")?.content || "";
    const reply = findBestReply(lastUserMsg, doctorListText);
    return res.json({ reply });

  } catch (error) {
    console.error("[Chat] Error:", error.message);

    if (error.status === 401) {
      // API key invalid — fall back to rule-based silently
      try {
        const { messages } = req.body;
        const trimmedMessages = (messages || []).slice(-20);
        const lastUserMsg = [...trimmedMessages].reverse().find(m => m.role === "user")?.content || "";
        const reply = findBestReply(lastUserMsg, null);
        return res.json({ reply });
      } catch (fallbackErr) {
        console.error("[Chat] Fallback error:", fallbackErr.message);
      }
    }

    res.status(500).json({ message: "The assistant is temporarily unavailable. Please try again in a moment." });
  }
});

module.exports = router;
