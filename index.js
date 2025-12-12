import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import QRCode from 'qrcode';
import multer from 'multer';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const FRONTEND_URL = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
const ADMIN_PIN = process.env.ADMIN_PIN;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY');
  process.exit(1);
}
if (!FRONTEND_URL) {
  console.error('Missing FRONTEND_URL');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const PHOTO_BUCKET = 'student-photos';
const QR_BUCKET = 'qr-codes';

// ------------------------------
// Helper: get public file URL from Supabase storage
async function getFileUrl(bucket, path) {
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl || null;
}

// ------------------------------
// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ------------------------------
// Student Registration
app.post('/api/student', upload.single('photo'), async (req, res) => {
  try {
    const { name, username, email, matric_number } = req.body;
    if (!name || !username || !email || !matric_number) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    // Insert student
    const { data: student, error: insertErr } = await supabase
      .from('students')
      .insert([{ name, username, email, matric_number }])
      .select()
      .single();
    if (insertErr) return res.status(500).json({ ok: false, error: insertErr.message });

    // Upload student photo
    let photo_url = null;
    if (req.file?.buffer) {
      const photoPath = `photo_${student.id}.png`;
      const { error: uploadErr } = await supabase.storage.from(PHOTO_BUCKET)
        .upload(photoPath, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
      if (!uploadErr) photo_url = await getFileUrl(PHOTO_BUCKET, photoPath);
    }

    // Generate QR code pointing to scan page
    const scanUrl = `${FRONTEND_URL}/scan?id=${encodeURIComponent(student.id)}`;
    const qrBuffer = await QRCode.toBuffer(scanUrl, { type: 'png', errorCorrectionLevel: 'H' });

    // Upload QR code
    const qrPath = `qr_${student.id}.png`;
    const { error: qrUploadErr } = await supabase.storage.from(QR_BUCKET)
      .upload(qrPath, qrBuffer, { contentType: 'image/png', upsert: true });
    if (qrUploadErr) return res.status(500).json({ ok: false, error: 'Failed to upload QR code' });

    const qr_code_url = await getFileUrl(QR_BUCKET, qrPath);

    // Update student record with photo and QR URLs
    await supabase.from('students').update({ photo_url, qr_code_url }).eq('id', student.id);

    return res.json({ ok: true, student: { ...student, photo_url, qr_code_url, scanUrl } });
  } catch (err) {
    console.error('Registration error:', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// ------------------------------
// Get student by ID
app.get('/api/student/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('students').select('*').eq('id', req.params.id).single();
    if (error) return res.status(404).json({ ok: false, error: 'Student not found' });
    return res.json({ ok: true, student: data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ------------------------------
// Attendance POST with once-per-day logic
app.post('/api/attendance', async (req, res) => {
  try {
    const { student_id, lecturer = 'Unknown', course = 'Unknown', admin_pin } = req.body;
    if (!student_id) return res.status(400).json({ ok: false, error: 'Missing student_id' });

    if (!ADMIN_PIN || !admin_pin || admin_pin !== ADMIN_PIN) {
      return res.status(403).json({ ok: false, error: 'Forbidden: invalid admin pin' });
    }

    const today = new Date().toISOString().slice(0, 10);

    // Check if attendance already exists today
    const { data: existing, error: checkErr } = await supabase
      .from('attendance')
      .select('*')
      .eq('student_id', student_id)
      .gte('created_at', today)
      .limit(1);

    if (checkErr) return res.status(500).json({ ok: false, error: checkErr.message });
    if (existing.length > 0) return res.json({ ok: false, error: 'Attendance already taken today' });

    // Insert attendance
    const { data, error: insertErr } = await supabase
      .from('attendance')
      .insert([{ student_id, lecturer, course }])
      .select()
      .single();
    if (insertErr) return res.status(500).json({ ok: false, error: insertErr.message });

    return res.json({ ok: true, attendance: data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ------------------------------
// External attendance marking (for third-party QR scanner)
app.get('/api/attendance/mark', async (req, res) => {
  try {
    const student_id = req.query.student_id;
    const pin = req.query.pin;

    if (!student_id) return res.status(400).send('<p>Missing student_id in query</p>');
    if (!pin || pin !== ADMIN_PIN) {
      return res.send(`
        <h3>Confirm attendance</h3>
        <p>Student ID: <strong>${student_id}</strong></p>
        <form method="GET" action="/api/attendance/mark">
          <input type="hidden" name="student_id" value="${student_id}" />
          PIN: <input name="pin" type="password" />
          <button type="submit">Submit</button>
        </form>
      `);
    }

    const today = new Date().toISOString().slice(0, 10);

    const { data: existing, error: checkErr } = await supabase
      .from('attendance')
      .select('*')
      .eq('student_id', student_id)
      .gte('created_at', today)
      .limit(1);

    if (checkErr) return res.status(500).send('Error checking attendance');
    if (existing.length > 0) return res.send('<h2>Attendance already taken today</h2>');

    const { data, error: insertErr } = await supabase
      .from('attendance')
      .insert([{ student_id, lecturer: 'external-scanner', course: 'Unknown' }])
      .select()
      .single();

    if (insertErr) return res.status(500).send('Failed to record attendance');

    return res.send(`
      <h2>Attendance recorded</h2>
      <p>Student ID: ${student_id}</p>
      <p>Time: ${new Date().toLocaleString()}</p>
    `);
  } catch (err) {
    console.error(err);
    return res.status(500).send('Server error');
  }
});

// ------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
