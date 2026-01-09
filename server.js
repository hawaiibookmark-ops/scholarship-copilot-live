require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const path = require('path');
const multer = require('multer'); // Tool for file uploads
const pdf = require('pdf-parse'); // Tool for reading PDFs

const app = express();
const upload = multer(); // Configure file uploader

// Middleware
app.use(express.json());
app.use(express.static(__dirname));

// Database Connection
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

// --- AUTO-FIX: Create Table if Missing ---
// This runs automatically when the server starts to fix your "Database Error"
pool.query(`
  CREATE TABLE IF NOT EXISTS student_profiles (
    user_id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    full_name VARCHAR(255),
    current_gpa VARCHAR(50),
    education_level VARCHAR(50),
    major_of_interest VARCHAR(255),
    personal_statement TEXT,
    extracurriculars TEXT,
    subscription_status VARCHAR(50) DEFAULT 'free',
    is_friends_family BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`).then(() => console.log("✅ Table 'student_profiles' is ready!"))
  .catch(err => console.error("❌ Table Error:", err));

// --- 1. SEARCH SCHOLARSHIPS ---
app.post('/api/search', async (req, res) => {
    const { query } = req.body;
    try {
        const response = await axios.post('https://api.perplexity.ai/chat/completions', {
            model: "sonar", 
            messages: [
                { role: "system", content: "You are a search assistant." },
                { role: "user", content: `Find scholarships/grants for: ${query}` }
            ]
        }, {
            headers: { 
                'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Search failed' });
    }
});

// --- 2. SAVE PROFILE ---
app.post('/api/save-profile', async (req, res) => {
    const { email, full_name, current_gpa, education_level, major_of_interest, personal_statement, extracurriculars } = req.body;
    
    const query = `
        INSERT INTO student_profiles (email, full_name, current_gpa, education_level, major_of_interest, personal_statement, extracurriculars)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (email) DO UPDATE SET 
            full_name = EXCLUDED.full_name,
            current_gpa = EXCLUDED.current_gpa,
            education_level = EXCLUDED.education_level,
            major_of_interest = EXCLUDED.major_of_interest,
            personal_statement = EXCLUDED.personal_statement,
            extracurriculars = EXCLUDED.extracurriculars,
            updated_at = CURRENT_TIMESTAMP
        RETURNING *;
    `;
    
    try {
        const result = await pool.query(query, [email, full_name, current_gpa, education_level, major_of_interest, personal_statement, extracurriculars]);
        res.status(200).json({ success: true, profile: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// --- NEW FEATURE: READ PDF RESUME ---
app.post('/api/upload-resume', upload.single('resume'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });
        
        const data = await pdf(req.file.buffer);
        // Send back text (limited to 10k chars)
        res.json({ success: true, text: data.text.slice(0, 10000) });
    } catch (err) {
        console.error("PDF Error:", err);
        res.status(500).json({ success: false, error: "Failed to read PDF" });
    }
});

// --- 3. WRITE GRANT / ESSAY ---
app.post('/api/write-essay', async (req, res) => {
    const { email, scholarship_prompt } = req.body;
    try {
        const result = await pool.query('SELECT * FROM student_profiles WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: "Profile not found." });
        
        const profile = result.rows[0];
        const aiPrompt = `
            ROLE: You are a Professional Grant Writer.
            TASK: Write a persuasive proposal based on the User Profile.
            USER DATA: Name: ${profile.full_name}, Mission: ${profile.major_of_interest}, Story: ${profile.personal_statement}, Details: ${profile.extracurriculars}
            PROMPT: "${scholarship_prompt}"
            GUIDELINES: Write in first person. Be professional and persuasive.
        `;

        const response = await axios.post('https://api.perplexity.ai/chat/completions', {
            model: "sonar", 
            messages: [{ role: "system", content: "You are an expert grant writer." }, { role: "user", content: aiPrompt }]
        }, {
            headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' }
        });

        let cleanText = response.data.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        res.json({ success: true, essay: cleanText });
    } catch (err) {
        res.status(500).json({ success: false, error: "AI generation failed." });
    }
});

// --- 4. ADMIN ROUTES ---
app.get('/api/admin/users', async (req, res) => {
    try {
        const result = await pool.query('SELECT user_id, email, full_name, subscription_status, created_at FROM student_profiles ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: "Database error" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));