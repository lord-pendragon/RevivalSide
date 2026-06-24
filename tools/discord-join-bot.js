"use strict";

require("dotenv/config");

const fs = require("node:fs/promises");
const path = require("node:path");

const {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require("discord.js");

const token = readRequiredEnv("DISCORD_BOT_TOKEN");
const targetGuildId = readOptionalEnv("DISCORD_GUILD_ID");
const testerRoleId = readOptionalEnv("DISCORD_TESTER_ROLE_ID");
const testerRoleName = stripRoleMention(readOptionalEnv("DISCORD_TESTER_ROLE_NAME") || "Tester") || "Tester";
const approvedRoleId = readOptionalEnv("DISCORD_APPROVED_ROLE_ID");
const approvedRoleName = stripRoleMention(readOptionalEnv("DISCORD_APPROVED_ROLE_NAME") || "Approved") || "Approved";
const testerTimerMs = 24 * 60 * 60 * 1000;
const timerSweepMs = Math.max(15_000, Number(readOptionalEnv("DISCORD_TESTER_TIMER_SWEEP_MS") || 60_000) || 60_000);
const rootDir = path.resolve(__dirname, "..");
const timerStatePath = path.resolve(
  rootDir,
  normalizeConfiguredPath(
    readOptionalEnv("DISCORD_TESTER_TIMER_STATE_PATH") || path.join("server-data", "discord-tester-timers.json")
  )
);

let timerState = createEmptyTimerState();

const joinCommand = new SlashCommandBuilder()
  .setName("join")
  .setDescription(`Grant yourself the @${testerRoleName} role.`);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async (readyClient) => {
  try {
    timerState = await loadTimerState();
    await registerCommands(readyClient);
    await sweepTesterTimers(readyClient);
    setInterval(() => {
      sweepTesterTimers(readyClient).catch((error) => {
        console.error("[discord-bot] tester timer sweep failed:", formatError(error));
      });
    }, timerSweepMs).unref();

    const scope = targetGuildId ? `guild ${targetGuildId}` : "global command scope";
    console.log(
      `[discord-bot] logged in as ${readyClient.user.tag}; /join registered for ${scope}; tester timers stored at ${timerStatePath}`
    );
  } catch (error) {
    console.error("[discord-bot] failed to register /join:", formatError(error));
    await readyClient.destroy();
    process.exitCode = 1;
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "join") {
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.editReply("Use /join inside the RevivalSide Discord server.");
    return;
  }

  if (targetGuildId && interaction.guildId !== targetGuildId) {
    await interaction.editReply("This bot is only configured for the RevivalSide Discord server.");
    return;
  }

  try {
    const testerRole = await resolveGuildRole(interaction.guild, testerRoleId, testerRoleName);
    if (!testerRole) {
      await interaction.editReply(
        testerRoleId
          ? "I could not find the configured Tester role ID."
          : `I could not find a server role named @${testerRoleName}.`
      );
      return;
    }

    const approvedRole = await resolveGuildRole(interaction.guild, approvedRoleId, approvedRoleName);
    if (!approvedRole) {
      await interaction.editReply(
        approvedRoleId
          ? "I could not find the configured Approved role ID."
          : `I could not find a server role named @${approvedRoleName}.`
      );
      return;
    }

    const me = await interaction.guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles) || !testerRole.editable) {
      await interaction.editReply(
        `I cannot grant @${testerRole.name} yet. Give the bot Manage Roles and place its role above @${testerRole.name}.`
      );
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const isApproved = member.roles.cache.has(approvedRole.id);
    const hasTester = member.roles.cache.has(testerRole.id);
    const existingTimer = getTesterTimer(interaction.guildId, interaction.user.id);

    if (hasTester) {
      if (isApproved) {
        if (clearTesterTimer(interaction.guildId, interaction.user.id)) {
          await saveTimerState();
        }
        await interaction.editReply(`You already have @${testerRole.name}. Approved users are not timed.`);
        return;
      }

      if (existingTimer) {
        await interaction.editReply(
          `You already have @${testerRole.name}. Your approval timer ends ${formatDiscordTimestamp(existingTimer.expiresAt)}.`
        );
        return;
      }

      const timer = startTesterTimer(interaction.guildId, interaction.user.id, testerRole.id, approvedRole.id);
      await saveTimerState();
      await interaction.editReply(
        `You already have @${testerRole.name}. Your approval timer now ends ${formatDiscordTimestamp(timer.expiresAt)}.`
      );
      return;
    }

    await member.roles.add(testerRole, "RevivalSide /join self-service role grant");

    if (isApproved) {
      if (clearTesterTimer(interaction.guildId, interaction.user.id)) {
        await saveTimerState();
      }
      await interaction.editReply(`Granted @${testerRole.name}. Approved users are not timed.`);
      return;
    }

    const timer = startTesterTimer(interaction.guildId, interaction.user.id, testerRole.id, approvedRole.id);
    await saveTimerState();
    await interaction.editReply(
      `Granted @${testerRole.name}. Get @${approvedRole.name} by ${formatDiscordTimestamp(timer.expiresAt)} or @${testerRole.name} will be removed.`
    );
  } catch (error) {
    console.error(`[discord-bot] /join failed for ${interaction.user.tag}:`, formatError(error));
    await interaction.editReply(
      "I could not grant the Tester role. Check the bot role hierarchy and Manage Roles permission."
    );
  }
});

client.login(token).catch((error) => {
  console.error("[discord-bot] login failed:", formatError(error));
  process.exitCode = 1;
});

async function registerCommands(readyClient) {
  const commands = [joinCommand.toJSON()];
  if (targetGuildId) {
    const guild = await readyClient.guilds.fetch(targetGuildId);
    await guild.commands.set(commands);
    return;
  }

  await readyClient.application.commands.set(commands);
}

async function sweepTesterTimers(readyClient) {
  const now = Date.now();
  let changed = false;

  for (const [guildId, guildTimers] of Object.entries(timerState.guilds)) {
    if (!guildTimers || typeof guildTimers !== "object") {
      delete timerState.guilds[guildId];
      changed = true;
      continue;
    }

    if (targetGuildId && guildId !== targetGuildId) {
      continue;
    }

    const guild = await readyClient.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      continue;
    }

    const testerRole = await resolveGuildRole(guild, testerRoleId, testerRoleName);
    const approvedRole = await resolveGuildRole(guild, approvedRoleId, approvedRoleName);
    if (!testerRole || !approvedRole) {
      console.warn(
        `[discord-bot] skipping tester timer sweep for guild ${guildId}; missing ${
          testerRole ? "Approved" : "Tester"
        } role`
      );
      continue;
    }

    const me = await guild.members.fetchMe();
    const canRemoveTester = me.permissions.has(PermissionFlagsBits.ManageRoles) && testerRole.editable;

    for (const [userId, timer] of Object.entries(guildTimers)) {
      const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
      if (!member) {
        delete guildTimers[userId];
        changed = true;
        continue;
      }

      if (member.roles.cache.has(approvedRole.id)) {
        delete guildTimers[userId];
        changed = true;
        console.log(`[discord-bot] cleared tester timer for approved user ${userId} in guild ${guildId}`);
        continue;
      }

      if (!member.roles.cache.has(testerRole.id)) {
        delete guildTimers[userId];
        changed = true;
        continue;
      }

      const expiresAtMs = Date.parse(timer.expiresAt || "");
      if (!Number.isFinite(expiresAtMs)) {
        delete guildTimers[userId];
        changed = true;
        continue;
      }

      if (expiresAtMs > now) {
        continue;
      }

      if (!canRemoveTester) {
        console.warn(
          `[discord-bot] tester timer expired for ${userId}, but the bot cannot remove @${testerRole.name} in guild ${guildId}`
        );
        continue;
      }

      await member.roles.remove(testerRole, "RevivalSide Tester timer expired without Approved role");
      delete guildTimers[userId];
      changed = true;
      console.log(`[discord-bot] removed @${testerRole.name} from unapproved user ${userId} in guild ${guildId}`);
    }

    if (Object.keys(guildTimers).length === 0) {
      delete timerState.guilds[guildId];
      changed = true;
    }
  }

  if (changed) {
    await saveTimerState();
  }
}

async function resolveGuildRole(guild, roleId, roleName) {
  if (roleId) {
    return guild.roles.fetch(roleId).catch(() => null);
  }

  const roles = await guild.roles.fetch().catch(() => null);
  if (!roles) {
    return null;
  }

  const normalizedName = roleName.toLowerCase();
  return roles.find((role) => role.name.toLowerCase() === normalizedName) || null;
}

function startTesterTimer(guildId, userId, currentTesterRoleId, currentApprovedRoleId) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + testerTimerMs);
  const guildTimers = getGuildTimers(guildId);
  guildTimers[userId] = {
    userId,
    startedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    testerRoleId: currentTesterRoleId,
    approvedRoleId: currentApprovedRoleId,
  };
  return guildTimers[userId];
}

function getTesterTimer(guildId, userId) {
  return timerState.guilds[guildId]?.[userId] || null;
}

function clearTesterTimer(guildId, userId) {
  const guildTimers = timerState.guilds[guildId];
  if (!guildTimers || !guildTimers[userId]) {
    return false;
  }

  delete guildTimers[userId];
  if (Object.keys(guildTimers).length === 0) {
    delete timerState.guilds[guildId];
  }
  return true;
}

function getGuildTimers(guildId) {
  timerState.guilds[guildId] ||= {};
  return timerState.guilds[guildId];
}

async function loadTimerState() {
  try {
    const raw = await fs.readFile(timerStatePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && parsed.guilds && typeof parsed.guilds === "object") {
      return parsed;
    }
    console.warn(`[discord-bot] ignoring invalid tester timer state at ${timerStatePath}`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`[discord-bot] could not read tester timer state: ${formatError(error)}`);
    }
  }

  return createEmptyTimerState();
}

async function saveTimerState() {
  await fs.mkdir(path.dirname(timerStatePath), { recursive: true });
  const tempPath = `${timerStatePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(timerState, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, timerStatePath);
}

function createEmptyTimerState() {
  return {
    version: 1,
    guilds: {},
  };
}

function formatDiscordTimestamp(isoTimestamp) {
  const unixSeconds = Math.floor(Date.parse(isoTimestamp) / 1000);
  if (!Number.isFinite(unixSeconds)) {
    return "in 24 hours";
  }
  return `<t:${unixSeconds}:R>`;
}

function readRequiredEnv(name) {
  const value = readOptionalEnv(name);
  if (!value) {
    console.error(`[discord-bot] missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function readOptionalEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function stripRoleMention(value) {
  return value.replace(/^@+/, "").trim();
}

function normalizeConfiguredPath(value) {
  return value.replace(/[\\/]+/g, path.sep);
}

function formatError(error) {
  if (!error) {
    return "unknown error";
  }
  if (error.stack) {
    return error.stack;
  }
  if (error.message) {
    return error.message;
  }
  return String(error);
}
