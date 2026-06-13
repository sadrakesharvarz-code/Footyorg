require('dotenv').config();
const path = require('path');
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve view pages
// Serve the user's root `index.html` if present. You previously had a top-level
// `index.html`; prefer that over `public/index.html` so the user's file is used.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.post('/login', (req, res) => {
  // placeholder logic
  res.redirect('/success');
});
app.get('/join', (req, res) => res.sendFile(path.join(__dirname, 'views', 'join.html')));
app.post('/join', (req, res) => {
  res.redirect('/success');
});
app.get('/create', (req, res) => res.sendFile(path.join(__dirname, 'views', 'create.html')));
app.post('/create', (req, res) => {
  res.redirect('/success');
});
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'views', 'success.html')));
app.get('/cancel', (req, res) => res.sendFile(path.join(__dirname, 'views', 'cancel.html')));

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
