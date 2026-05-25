const DEFAULT_MISSION_UPDATE_TABS = Object.freeze([1, 2, 3]);
const PENDING_MISSION_TRACKING_KEY = "__pendingMissionTracking";

function makeMissionTracking(now) {
  return {
    now,
    conditions: new Set(),
  };
}

function addMissionTrackingCondition(tracking, condition, tracked) {
  if (!tracking || tracked !== true) return false;
  const normalized = String(condition || "").trim();
  if (!normalized) return false;
  tracking.conditions.add(normalized);
  return true;
}

function queueMissionTracking(ctx, tracking) {
  if (!ctx || !tracking) return null;
  const normalized = normalizeMissionTracking(tracking);
  if (!normalized.conditions.length) return null;
  const existing = normalizeMissionTracking(ctx[PENDING_MISSION_TRACKING_KEY]);
  const merged = {
    now: normalized.now || existing.now,
    conditions: new Set([...existing.conditions, ...normalized.conditions]),
  };
  ctx[PENDING_MISSION_TRACKING_KEY] = merged;
  return merged;
}

function completeMissionTracking(ctx, socket, user, tracking, options = {}) {
  const pending = ctx ? ctx[PENDING_MISSION_TRACKING_KEY] : null;
  if (ctx) delete ctx[PENDING_MISSION_TRACKING_KEY];
  const merged = mergeMissionTrackings(pending, tracking);
  if (!merged.conditions.length) return false;
  const now = merged.now || options.now;
  const eventDateKey = options.eventDateKey || (ctx && typeof ctx.getMissionClockOptions === "function" ? ctx.getMissionClockOptions().eventDateKey : "");
  if (ctx && typeof ctx.refreshMissionProgress === "function") {
    ctx.refreshMissionProgress(user, { now, eventDateKey, conditions: merged.conditions });
  }
  return notifyMissionProgressUpdate(ctx, socket, user, {
    ...options,
    now,
    eventDateKey,
    conditions: merged.conditions,
  });
}

function notifyMissionProgressUpdate(ctx, socket, user, options = {}) {
  if (!ctx || !socket || !user) return false;
  const label = options.label || "mission-progress-update";
  if (typeof ctx.sendTrackedMissionUpdate === "function") {
    return ctx.sendTrackedMissionUpdate(socket, user, { now: options.now, eventDateKey: options.eventDateKey, label, conditions: options.conditions });
  }
  if (typeof ctx.sendMissionUpdateForTabs === "function") {
    return ctx.sendMissionUpdateForTabs(socket, user, options.tabIds || DEFAULT_MISSION_UPDATE_TABS, {
      now: options.now,
      eventDateKey: options.eventDateKey,
      label,
      conditions: options.conditions,
    });
  }
  if (typeof ctx.sendStageClearMissionUpdate === "function") {
    return ctx.sendStageClearMissionUpdate(socket, user, { now: options.now, label });
  }
  return false;
}

function mergeMissionTrackings(left, right) {
  const normalizedLeft = normalizeMissionTracking(left);
  const normalizedRight = normalizeMissionTracking(right);
  return {
    now: normalizedRight.now || normalizedLeft.now,
    conditions: Array.from(new Set([...normalizedLeft.conditions, ...normalizedRight.conditions])),
  };
}

function normalizeMissionTracking(tracking) {
  if (!tracking) return { now: undefined, conditions: [] };
  const sourceConditions =
    tracking.conditions || tracking.changedConditions || tracking.condition || tracking.changedCondition || [];
  const conditions = Array.from(
    new Set(
      (Array.isArray(sourceConditions) || sourceConditions instanceof Set ? Array.from(sourceConditions) : [sourceConditions])
        .map((condition) => String(condition || "").trim())
        .filter(Boolean)
    )
  );
  return {
    now: tracking.now,
    conditions,
  };
}

module.exports = {
  addMissionTrackingCondition,
  completeMissionTracking,
  makeMissionTracking,
  notifyMissionProgressUpdate,
  queueMissionTracking,
};
