const express = require('express');
const exampleController = require('./controllers/exampleController');

const app = express();
const PORT = process.env.PORT || 3000;

app.use('/example', exampleController);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

module.exports = app;
