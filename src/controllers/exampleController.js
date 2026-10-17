const express = require('express');

const router = express.Router();

// GET /example/path -> always returns "hello world" with 200
router.get('/path', (req, res) => {
  res.status(200).send('hello world');
});

module.exports = router;
