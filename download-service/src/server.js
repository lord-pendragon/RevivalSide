"use strict";

const { loadEnvFile } = require("./env-file");
const { createApp } = require("./app");
const { readConfig } = require("./config");

loadEnvFile();

const config = readConfig();
const { app } = createApp({ config });
const port = config.port;

app.listen(port, () => {
  console.log(`${config.serviceName} listening on http://127.0.0.1:${port}`);
});
