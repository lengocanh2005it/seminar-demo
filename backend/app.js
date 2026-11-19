const express = require('express');
const morgan = require('morgan');
const apiRouter = require('./routes/api');

// Lớp HTTP: CORS cho đúng origin Vite, log request, gắn router /api, chuẩn hoá lỗi.
const app = express();

// Vite dev server in ra 127.0.0.1, người dùng hay gõ localhost (và ngược lại);
// cả hai đều là cùng một dev server nên phải cùng được phép.
const allowedOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

app.use((req, res, next) => {
  // Chỉ cho phép origin của Vite dev server; origin lạ bị chặn 403.
  const origin = req.get('origin');
  if (origin && !allowedOrigins.has(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  res.set('Access-Control-Allow-Origin', origin || 'http://localhost:5173');
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(morgan('dev'));
app.use('/api', apiRouter);
// Trả 503 kèm id để đối chiếu với dòng lỗi tương ứng trong terminal của UI.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(503).json({ error: err.message, id: res.locals.operationId });
});

module.exports = app;
