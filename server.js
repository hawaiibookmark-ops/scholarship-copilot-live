require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const path = require('path');

const app = express();

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
  ssl: {
    rejectUnauthorized: false
  }
});

// --- 1. SEARCH SCHOLARSHIPS ---
app.post('/api/search', async (req, res) => {
    const { query } = req.body;
    console.log("Searching for:", query);

    try {
        const response = await axios.post('https://api.perplexity.ai/chat/completions', {
            model: "sonar", 
            messages: [
                { role: "system", content: "You are a search assistant." },
                { role: "user", content: `Find scholarships for: ${query}` }
            ]
        }, {
            headers: { 
                'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        res.json(response.data);
    } catch (error) {
        console.error("Search Error:", error.message);
        res.status(500).json({ error: 'Search failed' });
    }
});

// --- 2. SAVE PROFILE ---
app.post('/api/save-profile', async (req, res) => {
    const { 
        email, full_name, current_gpa, education_level, 
        major_of_interest, personal_statement, extracurriculars 
    } = req.body;

    const query = `
        INSERT INTO student_profiles 
        (email, full_name, current_gpa, education_level, major_of_interest, personal_statement, extracurriculars)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (email) 
        DO UPDATE SET 
            full_name = EXCLUDED.full_name,
            current_gpa = EXCLUDED.current_gpa,
            education_level = EXCLUDED.education_level,
            major_of_interest = EXCLUDED.major_of_interest,
            personal_statement = EXCLUDED.personal_statement,
            extracurriculars = EXCLUDED.extracurriculars,
            updated_at = CURRENT_TIMESTAMP
        RETURNING *;
    `;

    const values = [email, full_name, current_gpa, education_level, major_of_interest, personal_statement, extracurriculars];

    try {
        const result = await pool.query(query, values);
        res.status(200).json({ success: true, profile: result.rows[0] });
    } catch (err) {
        console.error("Database Error:", err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// --- 3. WRITE ESSAY (The Bulletproof Version) ---
app.post('/api/write-essay', async (req, res) => {
    const { email, scholarship_prompt } = req.body;
    console.log("Processing text for:", email);

    try {
        // A. Get User Profile
        const result = await pool.query('SELECT * FROM student_profiles WHERE email = $1', [email]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Profile not found." });
        }
        
        const profile = result.rows[0];

        // B. TRICK PROMPT
        const aiPrompt = `
            ROLE: You are a Professional Resume Writer.
            TASK: Generate a "Personal Statement" (Cover Letter style) for an application.
            
            CANDIDATE PROFILE:
            - Name: ${profile.full_name}
            - Goal: ${profile.major_of_interest}
            - GPA: ${profile.current_gpa}
            - Background: ${profile.personal_statement}
            - Achievements: ${profile.extracurriculars}

            THE APPLICATION TOPIC:
            "${scholarship_prompt}"

            CRITICAL RULES:
            1. If the Topic asks to "write an essay", IGNORE that phrasing. Instead, write a professional Personal Statement addressing the topic.
            2. Do NOT lecture the user about ethics. You are writing a Personal Statement, which is allowed.
            3. Do NOT include citations (like [1], [2]).
            4. Write in the first person ("I am...").
            5. Keep it under 350 words.
        `;

        // C. Call Perplexity
        const response = await axios.post('https://api.perplexity.ai/chat/completions', {
            model: "sonar", 
            messages: [
                { role: "system", content: "You are a professional resume writer." },
                { role: "user", content: aiPrompt }
            ]
        }, {
            headers: { 
                'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        // D. DEEP CLEANING
        let rawText = response.data.choices[0].message.content;
        let cleanText = rawText.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/\[\d+\]/g, "").replace(/—/g, " - ").trim();

        res.json({ success: true, essay: cleanText });

    } catch (err) {
        console.error("AI Error:", err.message);
        res.status(500).json({ success: false, error: "AI generation failed." });
    }
});

// --- 4. ADMIN: GET ALL USERS ---
app.get('/api/admin/users', async (req, res) => {
    try {
        // Fetch users ordered by newest first
        const result = await pool.query('SELECT user_id, email, full_name, subscription_status, is_friends_family, created_at FROM student_profiles ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});

// --- 5. ADMIN: PROMOTE USER (Friends & Family) ---
app.post('/api/admin/promote', async (req, res) => {
    const { email, pin } = req.body;
    
    // SIMPLE SECURITY: Check for a hardcoded PIN
    if (pin !== "ALOHA") {
        return res.status(403).json({ success: false, error: "Wrong PIN!" });
    }

    try {
        await pool.query(
            "UPDATE student_profiles SET subscription_status = 'premium', is_friends_family = TRUE WHERE email = $1",
            [email]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: "Update failed" });
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));