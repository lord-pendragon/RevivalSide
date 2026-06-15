const fs = require("fs");
const path = require("path");

function loadPacketHandlers(handlerRoots, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const handlers = new Map();
  const duplicates = [];
  const handlerFiles = collectPacketHandlerFiles(handlerRoots, rootDir);

  for (const filePath of handlerFiles) {
    const fileName = path.relative(rootDir, filePath);
    try {
      const exported = require(filePath);
      const fileHandlers = Array.isArray(exported)
        ? exported
        : Array.isArray(exported.handlers)
          ? exported.handlers
          : [exported];
      for (const handler of fileHandlers) {
        if (typeof handler.packetId !== "number" || typeof handler.handle !== "function") {
          console.log(`[handlers] skip ${fileName}; missing packetId/handle`);
          continue;
        }
        if (handlers.has(handler.packetId)) {
          duplicates.push({
            packetId: handler.packetId,
            ignoredFileName: fileName,
            existingFileName: handlers.get(handler.packetId).fileName || "",
          });
          continue;
        }
        handlers.set(handler.packetId, { ...handler, fileName });
      }
    } catch (err) {
      console.log(`[handlers] failed to load ${fileName}: ${err.message}`);
    }
  }

  logDuplicatePacketHandlers(duplicates, options);
  console.log(`[handlers] loaded ${handlers.size} packet handlers from ${handlerFiles.length} files`);
  return handlers;
}

function logDuplicatePacketHandlers(duplicates, options = {}) {
  const list = Array.isArray(duplicates) ? duplicates : [];
  if (!list.length) return;

  const grouped = new Map();
  for (const duplicate of list) {
    const key = `${duplicate.ignoredFileName}\0${duplicate.existingFileName}`;
    const group = grouped.get(key) || {
      ignoredFileName: duplicate.ignoredFileName,
      existingFileName: duplicate.existingFileName,
      packetIds: [],
    };
    group.packetIds.push(duplicate.packetId);
    grouped.set(key, group);
  }

  if (!shouldLogDuplicatePacketHandlerDetails(options)) {
    const ignoredFiles = new Set(list.map((duplicate) => duplicate.ignoredFileName).filter(Boolean));
    console.log(
      `[handlers] ignored ${list.length} duplicate packet handlers across ${ignoredFiles.size} files (first handler wins)`
    );
    return;
  }

  const details = Array.from(grouped.values()).map((group) => {
    const packetIds = group.packetIds.sort((left, right) => left - right);
    const sample = packetIds.slice(0, 8).join(",");
    const more = packetIds.length > 8 ? `,+${packetIds.length - 8} more` : "";
    const existing = group.existingFileName || "earlier handler";
    return `${group.ignoredFileName} ignored ${packetIds.length} ids (${sample}${more}) already handled by ${existing}`;
  });
  console.log(`[handlers] ignored ${list.length} duplicate packet handlers: ${details.join("; ")}`);
}

function shouldLogDuplicatePacketHandlerDetails(options = {}) {
  if (options.logDuplicatePacketHandlerDetails != null) return Boolean(options.logDuplicatePacketHandlerDetails);
  const value = String(process.env.CS_LOG_DUPLICATE_PACKET_HANDLER_DETAILS || "").trim().toLowerCase();
  return ["1", "true", "yes", "on", "verbose"].includes(value);
}

function collectPacketHandlerFiles(handlerRoots, rootDir) {
  const roots = Array.isArray(handlerRoots) ? handlerRoots : [handlerRoots];
  const files = [];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) {
      console.log(`[handlers] no packet handler directory at ${root}`);
      continue;
    }
    collectPacketHandlerFilesFrom(root, files);
  }
  return files.sort((left, right) => compareHandlerFilePaths(left, right, rootDir));
}

function collectPacketHandlerFilesFrom(target, files) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (target.endsWith(".js")) files.push(target);
    return;
  }
  if (!stat.isDirectory()) return;

  const baseName = path.basename(target).toLowerCase();
  if (baseName === "handlers" || baseName === "packet-handlers") {
    for (const entry of fs.readdirSync(target).filter((file) => file.endsWith(".js")).sort()) {
      files.push(path.join(target, entry));
    }
    return;
  }

  for (const entry of fs.readdirSync(target).sort()) {
    const child = path.join(target, entry);
    if (fs.statSync(child).isDirectory()) collectPacketHandlerFilesFrom(child, files);
  }
}

function compareHandlerFilePaths(left, right, rootDir) {
  const leftName = path.basename(left);
  const rightName = path.basename(right);
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;

  const leftPath = path.relative(rootDir, left);
  const rightPath = path.relative(rootDir, right);
  if (leftPath < rightPath) return -1;
  if (leftPath > rightPath) return 1;
  return 0;
}

module.exports = {
  loadPacketHandlers,
};
