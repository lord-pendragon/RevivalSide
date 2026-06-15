"use strict";

const fs = require("node:fs");
const path = require("node:path");

function loadEnvFile(filePath = path.join(__dirname, "..", ".env")) {
  if (!fs.existsSync(filePath)) return false;

  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) continue;

    const name = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (!name || process.env[name] !== undefined) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[name] = value.replace(/\\n/g, "\n");
  }

  return true;
}

module.exports = { loadEnvFile };
