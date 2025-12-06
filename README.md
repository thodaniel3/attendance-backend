# Attendance Backend (local run)

1. Copy .env.example to .env and fill values:
   - SUPABASE_URL (your supabase url)
   - SUPABASE_SERVICE_ROLE (service role key)
   - SUPABASE_ANON_KEY (optional)
   - SENDGRID_API_KEY (optional)
   - EMAIL_FROM (e.g. "MME Attendance <noreply@yourdomain.com>")
   - ADMIN_SECRET (e.g. myattendancesecret2025)
   - FRONTEND_URL (e.g. http://localhost:5500)

2. Install:
   npm install

3. Run locally:
   npm run dev

4. Backend will be available at http://localhost:3000
