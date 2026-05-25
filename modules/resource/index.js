const {
  RESOURCE_ITEM_IDS,
  spendMiscItem,
  toBigInt,
} = require("../inventory");
const {
  FALLBACK_RESOURCE_ITEM_ID,
  FALLBACK_RESOURCE_COUNT,
  createEmptyReward,
  grantRewardByType,
} = require("../reward");

const PURCHASE_DEDUPE_MS = Number(process.env.CS_RESOURCE_PURCHASE_DEDUPE_MS || 10000);
const TRACK_SHOP_PURCHASE_LIMITS = process.env.CS_SHOP_TRACK_PURCHASE_LIMITS === "1";

function isRealMoneyProduct(record) {
  return Number(record && record.m_PriceItemID) === 0;
}

function isRealMoneyResourceProduct(record) {
  return isRealMoneyProduct(record) && String(record && record.m_ItemType) === "RT_MISC";
}

function isCoreResourceItemId(itemId) {
  const id = Number(itemId);
  return Object.values(RESOURCE_ITEM_IDS).includes(id);
}

function grantShopProduct(ctx, user, record, productCount = 1) {
  if (!record) return grantFallbackResource(ctx, user, productCount);

  const count = Math.max(1, Number(productCount) || 1);
  const itemType = String(record.m_ItemType || "");
  const itemId = Number(record.m_ItemID);
  const regDate = ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n;
  const reward = createEmptyReward();

  if (!Number.isInteger(itemId) || itemId <= 0) return grantFallbackResource(ctx, user, count);

  const granted = grantRewardByType(
    ctx,
    user,
    itemType,
    itemId,
    toBigInt(record.m_FreeValue != null ? record.m_FreeValue : record.m_Value || 1, 1n) * BigInt(count),
    toBigInt(record.m_FreeValue != null ? record.m_FreeValue : record.m_Value || 1, 1n) * BigInt(count),
    toBigInt(record.m_PaidValue || 0, 0n) * BigInt(count),
    { regDate, expandPackages: true }
  );
  for (const key of ["miscItems", "skinIds", "emoticonIds", "units", "operators", "equips", "moldItems"]) {
    if (Array.isArray(granted[key])) reward[key].push(...granted[key]);
  }

  recordShopPurchase(user, Number(record.m_ProductID) || 0, count);
  return reward;
}

function spendShopPrice(ctx, user, record, productCount = 1) {
  if (!record || isRealMoneyProduct(record)) return null;
  const itemId = Number(record.m_PriceItemID);
  const unitPrice = toBigInt(record.m_Price || 0, 0n);
  const count = Math.max(1, Number(productCount) || 1);
  const totalPrice = unitPrice * BigInt(count);
  if (!Number.isInteger(itemId) || itemId <= 0 || totalPrice <= 0n) return null;

  const regDate = ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n;
  const updated = spendMiscItem(user, itemId, totalPrice, { regDate });
  if (updated && isCoreResourceItemId(itemId)) {
    console.log(
      `[resource] spend itemId=${itemId} amount=${totalPrice.toString()} balanceFree=${updated.countFree} balancePaid=${updated.countPaid}`
    );
  }
  return updated;
}

function grantFallbackResource(ctx, user, multiplier = 1) {
  const reward = createEmptyReward();
  const regDate = ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n;
  const grant = grantRewardByType(ctx, user, "RT_MISC", FALLBACK_RESOURCE_ITEM_ID, FALLBACK_RESOURCE_COUNT * BigInt(Math.max(1, Number(multiplier) || 1)), null, 0n, { regDate, expandPackages: false });
  for (const key of ["miscItems", "skinIds", "emoticonIds", "units", "operators", "equips", "moldItems"]) {
    if (Array.isArray(grant[key])) reward[key].push(...grant[key]);
  }
  return reward;
}

function recordShopPurchase(user, productId, productCount = 1) {
  if (!user || !Number.isInteger(Number(productId)) || Number(productId) <= 0) return null;
  if (!TRACK_SHOP_PURCHASE_LIMITS) {
    return {
      shopId: Number(productId),
      purchaseCount: 0,
      purchaseTotalCount: 0,
      nextResetDate: "0",
    };
  }
  user.shopPurchaseHistory =
    user.shopPurchaseHistory && typeof user.shopPurchaseHistory === "object" ? user.shopPurchaseHistory : {};
  const key = String(Number(productId));
  const existing = user.shopPurchaseHistory[key] || {};
  const purchaseCount = Number(existing.purchaseCount || 0) + Math.max(1, Number(productCount) || 1);
  const history = {
    shopId: Number(productId),
    purchaseCount,
    purchaseTotalCount: Number(existing.purchaseTotalCount || 0) + Math.max(1, Number(productCount) || 1),
    nextResetDate: String(existing.nextResetDate || "0"),
  };
  user.shopPurchaseHistory[key] = history;
  return history;
}

function getShopPurchaseHistories(user) {
  if (!TRACK_SHOP_PURCHASE_LIMITS) return [];
  const history = user && user.shopPurchaseHistory && typeof user.shopPurchaseHistory === "object" ? user.shopPurchaseHistory : {};
  return Object.values(history)
    .map((entry) => ({
      shopId: Number(entry.shopId || 0),
      purchaseCount: Number(entry.purchaseCount || 0),
      purchaseTotalCount: Number(entry.purchaseTotalCount || 0),
      nextResetDate: String(entry.nextResetDate || "0"),
    }))
    .filter((entry) => entry.shopId > 0);
}

function getPurchaseKey(source, productId, request = {}) {
  const normalizedSource = source || "shop";
  let explicit = "";
  if (normalizedSource === "steam") {
    explicit = request.productId || productId;
  } else if (normalizedSource === "cash") {
    explicit = request.productMarketID || request.productId || request.productID || productId;
  } else if (normalizedSource === "gamebase") {
    explicit = request.paymentId || request.paymentSeq || productId;
  } else {
    explicit =
      request.orderId ||
      request.paymentSeq ||
      request.paymentId ||
      request.validationToken ||
      request.productMarketID ||
      request.productId ||
      request.productID ||
      productId;
  }
  return `${normalizedSource}:${String(explicit || productId || "unknown")}`;
}

function hasCompletedPurchase(socket, key) {
  const state = getResourcePurchaseState(socket);
  if (!key || !state.completed[key]) return false;
  const completedAt = Number(state.completed[key] || 0);
  if (Date.now() - completedAt <= PURCHASE_DEDUPE_MS) return true;
  delete state.completed[key];
  return false;
}

function markCompletedPurchase(socket, key) {
  if (!key) return;
  const state = getResourcePurchaseState(socket);
  state.completed[key] = Date.now();
}

function getResourcePurchaseState(socket) {
  if (!socket || !socket.session) return { completed: {} };
  socket.session.resourcePurchases =
    socket.session.resourcePurchases && typeof socket.session.resourcePurchases === "object"
      ? socket.session.resourcePurchases
      : { completed: {} };
  socket.session.resourcePurchases.completed =
    socket.session.resourcePurchases.completed && typeof socket.session.resourcePurchases.completed === "object"
      ? socket.session.resourcePurchases.completed
      : {};
  return socket.session.resourcePurchases;
}

function makeLocalOrderId(productId) {
  return `local-resource-${Number(productId) || 0}-${Date.now()}`;
}

module.exports = {
  createEmptyReward,
  isRealMoneyProduct,
  isRealMoneyResourceProduct,
  isCoreResourceItemId,
  grantShopProduct,
  spendShopPrice,
  grantFallbackResource,
  recordShopPurchase,
  getShopPurchaseHistories,
  getPurchaseKey,
  hasCompletedPurchase,
  markCompletedPurchase,
  makeLocalOrderId,
};
