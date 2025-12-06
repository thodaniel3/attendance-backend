require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fileUpload = require('express-fileupload');
const fetch = require('node-fetch');
const path = require('path');

const app = express();

// ---------- Middleware ----------
app.use(cors()); // allow all origins
app.use(express.json());
app.use(fileUpload()); // for multipart/form-data

// ---------- Supabase ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'myattendancesecret2025';

// ---------- Helpers ----------
async function uploadToStorage(bucket, path, buffer, contentType = 'application/octet-stream') {
  const { data, error } = await supabase.storage.from(bucket).upload(path, buffer, { contentType, upsert: true });
  if (error) throw error;
  const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
  return pub.publicUrl;
}

function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.body.admin_secret || '';
  if (secret !== ADMIN_SECRET) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// ---------- Routes ----------

// Health check
app.get('/', (req, res) => res.json({ ok: true, message: 'Attendance backend is running' }));

// Create student
app.post('/api/create-student', async (req, res) => {
  try {
    const { name, username, matric_number, email } = req.body;
    if (!name || !username || !matric_number || !email)
      return res.status(400).json({ ok: false, error: 'Missing fields' });

    // 1) Create student row
    const { data: created, error: insertErr } = await supabase
      .from('students')
      .insert([{ name, username, matric_number, email }])
      .select()
      .single();
    if (insertErr) throw insertErr;
    const studentId = created.id;

    // 2) Upload photo if exists
    let photoUrl = null;
    if (req.files && req.files.photo) {
      const file = req.files.photo;
      const ext = (file.mimetype.split('/')[1] || 'jpg').split('+')[0];
      const photoPath = `student-photos/${studentId}.${ext}`;
      photoUrl = await uploadToStorage('student-photos', photoPath, file.data, file.mimetype);
      await supabase.from('students').update({ photo_url: photoUrl }).eq('id', studentId);
    }

    // 3) Generate QR
    const qrPayload = `attendance://${studentId}`;
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qrPayload)}`;
    const qrResp = await fetch(qrApiUrl);
    const qrBuffer = await qrResp.arrayBuffer();
    const qrPath = `qr-codes/${studentId}.png`;
    const qrUrl = await uploadToStorage('qr-codes', qrPath, Buffer.from(qrBuffer), 'image/png');

    // 4) Update student with QR URL
    await supabase.from('students').update({ qr_code_url: qrUrl }).eq('id', studentId);

    // 5) Return student JSON
    res.json({ ok: true, student: { ...created, photo_url: photoUrl, qr_code_url: qrUrl } });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

// Record attendance
app.post('/api/attendance', requireAdmin, async (req, res) => {
  try {
    const { student_id, scanned_by } = req.body;
    if (!student_id) return res.status(400).json({ ok: false, error: 'Missing student_id' });

    const today = new Date().toISOString().slice(0, 10);
    const { data: existing } = await supabase
      .from('attendance')
      .select('id')
      .eq('student_id', student_id)
      .eq('date', today)
      .limit(1);

    if (existing && existing.length) return res.json({ ok: true, message: 'Already recorded' });

    const { data, error } = await supabase
      .from('attendance')
      .insert([{ student_id, date: today, status: 'Present', scanned_by }])
      .select()
      .single();
    if (error) throw error;

    res.json({ ok: true, data });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

// ---------------------
// Catch-all for unknown routes (return JSON instead of HTML)
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Route not found' });
});

// ---------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Attendance backend running on port ${PORT}`));
