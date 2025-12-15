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

if (!SUPABASE_URL || !SUPABASE_KEY || !FRONTEND_URL || !ADMIN_PIN) {
  console.error('❌ Missing environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const PHOTO_BUCKET = 'student-photos';
const QR_BUCKET = 'qr-codes';

// ------------------------------
// Helper: get public file URL
async function getFileUrl(bucket, path) {
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl || null;
}

// ------------------------------
// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// ------------------------------
// Student Registration
app.post('/api/student', upload.single('photo'), async (req, res) => {
  try {
    const { name, username, email, matric_number } = req.body;

    if (!name || !username || !email || !matric_number) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    const { data: student, error } = await supabase
      .from('students')
      .insert([{ name, username, email, matric_number }])
      .select()
      .single();

    if (error) return res.status(500).json({ ok: false, error: error.message });

    let photo_url = null;

    if (req.file?.buffer) {
      const photoPath = `photo_${student.id}.png`;
      await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(photoPath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: true
        });

      photo_url = await getFileUrl(PHOTO_BUCKET, photoPath);
    }

    const scanUrl = `${FRONTEND_URL}/scan?id=${student.id}`;
    const qrBuffer = await QRCode.toBuffer(scanUrl);

    const qrPath = `qr_${student.id}.png`;
    await supabase.storage
      .from(QR_BUCKET)
      .upload(qrPath, qrBuffer, {
        contentType: 'image/png',
        upsert: true
      });

    const qr_code_url = await getFileUrl(QR_BUCKET, qrPath);

    await supabase
      .from('students')
      .update({ photo_url, qr_code_url })
      .eq('id', student.id);

    res.json({
      ok: true,
      student: { ...student, photo_url, qr_code_url }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Registration failed' });
  }
});

// ------------------------------
// Get student
app.get('/api/student/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('students')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ ok: false, error: 'Student not found' });

  res.json({ ok: true, student: data });
});

// ------------------------------
// ✅ ATTENDANCE (FIXED LOGIC)
app.post('/api/attendance', async (req, res) => {
  try {
    const { student_id, lecturer, course, admin_pin } = req.body;

    if (!student_id || !lecturer || !course) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    if (admin_pin !== ADMIN_PIN) {
      return res.status(403).json({ ok: false, error: 'Invalid admin PIN' });
    }

    // Today range
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // 🔍 CHECK: same student + same course + same lecturer + same day
    const { data: existing, error: checkErr } = await supabase
      .from('attendance')
      .select('id')
      .eq('student_id', student_id)
      .eq('course', course)
      .eq('lecturer', lecturer)
      .gte('created_at', startOfDay.toISOString())
      .lte('created_at', endOfDay.toISOString())
      .limit(1);

    if (checkErr) {
      return res.status(500).json({ ok: false, error: checkErr.message });
    }

    if (existing.length > 0) {
      return res.json({
        ok: false,
        error: 'Attendance already taken for this course today'
      });
    }

    // ✅ INSERT attendance
    const { data, error } = await supabase
      .from('attendance')
      .insert([{ student_id, lecturer, course }])
      .select()
      .single();

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    res.json({ ok: true, attendance: data });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
