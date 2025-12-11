import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import QRCode from 'qrcode';
import multer from 'multer';

const app = express();
app.use(cors({ origin: '*' }));

// ---------- MULTER SETUP (for file uploads) ----------
const upload = multer({ storage: multer.memoryStorage() });

// ---------- SUPABASE SETUP ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const PHOTO_BUCKET = 'student-photos';
const QR_BUCKET = 'qr-codes';

// ---------- HELPERS ----------
async function getFileUrl(bucket, path) {
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl || null;
}

// ---------- JSON PARSER ----------
app.use(express.json());

// ---------- HEALTH CHECK ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- REGISTER STUDENT ----------
app.post('/api/student', upload.single('photo'), async (req, res) => {
  try {
    const { name, username, email, matric_number } = req.body;

    if (!name || !username || !email || !matric_number) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: name, username, email, matric_number'
      });
    }

    // Insert student into Supabase
    const { data: student, error: insertErr } = await supabase
      .from('students')
      .insert([{ name, username, email, matric_number }])
      .select()
      .single();

    if (insertErr) return res.status(500).json({ ok: false, error: insertErr.message });

    // Upload photo
    let photo_url = null;
    if (req.file && req.file.buffer) {
      const photoPath = `photo_${student.id}.png`;
      const { error: uploadErr } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(photoPath, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
      if (!uploadErr) photo_url = await getFileUrl(PHOTO_BUCKET, photoPath);
    }

    // Generate QR code
    const qrPayload = JSON.stringify({ id: student.id });
    const qrBuffer = await QRCode.toBuffer(qrPayload);
    const qrPath = `qr_${student.id}.png`;
    await supabase.storage.from(QR_BUCKET).upload(qrPath, qrBuffer, { contentType: 'image/png', upsert: true });
    const qr_code_url = await getFileUrl(QR_BUCKET, qrPath);

    // Update student with URLs
    await supabase.from('students')
      .update({ photo_url, qr_code_url })
      .eq('id', student.id);

    res.json({
      ok: true,
      student: { ...student, photo_url, qr_code_url }
    });

  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- GET ALL STUDENTS ----------
app.get('/api/student', async (req, res) => {
  try {
    const { data, error } = await supabase.from('students').select('*');
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, students: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- GET STUDENT BY ID ----------
app.get('/api/student/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('students').select('*').eq('id', req.params.id).single();
    if (error) return res.status(404).json({ ok: false, error: 'Student not found' });
    res.json({ ok: true, student: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- ATTENDANCE ----------
app.post('/api/attendance', async (req, res) => {
  try {
    const { student_id, lecturer = "Unknown", course = "Unknown" } = req.body;
    if (!student_id) return res.status(400).json({ ok: false, error: "Missing student_id" });

    const { data, error } = await supabase.from('attendance')
      .insert([{ student_id, lecturer, course }])
      .select()
      .single();

    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, attendance: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- LISTEN ON PORT ----------
const PORT = process.env.PORT || 5000; // <-- Will use Render's PORT or 5000 locally
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
