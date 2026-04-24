require('dotenv').config();

const express = require('express');
const path = require('path');

const transcribeRouter = require('./routes/transcribe');
const playbackRouter = require('./routes/playback');
const coachRouter = require('./routes/coach');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(transcribeRouter);
app.use(playbackRouter);
app.use(coachRouter);

app.listen(PORT, () => {
  console.log(`Reunion Ready is serving looks on port ${PORT} 💅`);
});
