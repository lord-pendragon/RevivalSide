const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.join(ROOT_DIR, "gameplay-tables-json", "Assetbundles");
const OUTPUT_ROOT = path.join(ROOT_DIR, "gameplay-jsons", "Assetbundles");

const UNIT_KEYS = [
  "m_UnitID",
  "m_UnitStrID",
  "m_NKM_UNIT_TYPE",
  "m_NKM_UNIT_STYLE_TYPE",
  "m_NKM_UNIT_ROLE_TYPE",
  "m_bMonster",
  "m_bContractable",
  "m_StarGradeMax",
  "m_NKM_UNIT_GRADE",
  "m_bAwaken",
  "m_BaseUnitID",
  "m_bProfileMainUnit",
  "m_SkillStrID1",
  "m_SkillStrID2",
  "m_SkillStrID3",
  "m_SkillStrID4",
  "m_SkillStrID5",
];

const TABLES = [
  {
    directory: "ab_script_unit_data",
    fileName: "LUA_UNIT_TEMPLET_BASE.json",
    keys: UNIT_KEYS,
  },
  {
    directory: "ab_script_unit_data",
    fileName: "LUA_UNIT_TEMPLET_BASE2.json",
    keys: UNIT_KEYS,
  },
  {
    directory: "ab_script_unit_data",
    fileName: "LUA_UNIT_TEMPLET_BASE_SD.json",
    keys: UNIT_KEYS,
  },
  {
    directory: "ab_script_unit_data",
    fileName: "LUA_UNIT_TEMPLET_BASE_OPR.json",
    keys: UNIT_KEYS,
  },
  {
    directory: "ab_script",
    fileName: "LUA_COLLECTION_UNIT_TEMPLET.json",
    keys: ["Idx", ...UNIT_KEYS, "m_UnitIntro"],
  },
  {
    directory: "ab_script_unit_data",
    fileName: "LUA_UNIT_SKILL_TEMPLET.json",
    keys: ["m_UnitSkillID", "m_Level", "m_UnitSkillStrID"],
  },
  {
    directory: "ab_script_unit_data",
    fileName: "LUA_UNIT_EXP_TABLE.json",
    keys: ["m_iLevel", "m_iExpRequired", "m_iExpCumulated"],
  },
  {
    directory: "ab_script_unit_data",
    fileName: "LUA_OPERATOR_EXP_TEMPLET.json",
    keys: ["m_iLevel", "m_NKM_UNIT_GRADE", "m_iExpRequiredOpr", "m_iExpCumulatedOpr"],
  },
  {
    directory: "ab_script",
    fileName: "LUA_PLAYER_EXP_TABLE.json",
    keys: ["m_iLevel", "m_lExpRequired", "m_lExpCumulated"],
  },
  {
    directory: "ab_script",
    fileName: "LUA_LIMITBREAK_INFO.json",
    keys: ["m_iLBRank", "m_iMaxLevel"],
  },
  {
    directory: "ab_script",
    fileName: "LUA_EVENTDECK_TEMPLET.json",
    transform: trimEventDeckRecord,
  },
];

function main() {
  if (!fs.existsSync(SOURCE_ROOT)) {
    throw new Error(`Missing source gameplay JSON root: ${SOURCE_ROOT}`);
  }

  let totalRecords = 0;
  for (const table of TABLES) {
    const source = readTable(table.directory, table.fileName);
    const records = (source.records || []).map((record) =>
      table.transform ? table.transform(record) : pick(record, table.keys)
    );
    writeTable(table.directory, table.fileName, {
      source: source.source || sourcePath(table.directory, table.fileName),
      rootName: source.rootName || "",
      recordCount: records.length,
      records,
    });
    totalRecords += records.length;
  }

  writeNewAccountDefaults();
  console.log(`[gameplay-jsons] wrote ${TABLES.length} tables (${totalRecords} records) to ${OUTPUT_ROOT}`);
}

function readTable(directory, fileName) {
  const filePath = sourcePath(directory, fileName);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeTable(directory, fileName, data) {
  const outputPath = path.join(OUTPUT_ROOT, directory, "luac", fileName);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function sourcePath(directory, fileName) {
  return path.join(SOURCE_ROOT, directory, "luac", fileName);
}

function pick(record, keys) {
  const result = {};
  for (const key of keys) {
    if (record && record[key] !== undefined) result[key] = record[key];
  }
  return result;
}

function trimEventDeckRecord(record) {
  const result = pick(record, ["ID", "NAME", "SLOT_TYPE_SHIP", "SLOT_UNIT_ID_SHIP", "SLOT_UNIT_LEVEL_SHIP"]);
  for (let slot = 1; slot <= 16; slot += 1) {
    for (const key of [`SLOT_TYPE_UNIT_${slot}`, `SLOT_UNIT_ID_${slot}`, `SLOT_UNIT_LEVEL_${slot}`]) {
      if (record && record[key] !== undefined) result[key] = record[key];
    }
  }
  return result;
}

function writeNewAccountDefaults() {
  const outputPath = path.join(ROOT_DIR, "gameplay-jsons", "new-account-defaults.json");
  const data = {
    source: [
      "Assembly-CSharp/NKM/NKMUserData.cs",
      "Assembly-CSharp/NKM/NKMArmyData.cs",
      "Assembly-CSharp/NKM/NKMUserOption.cs",
      "Assembly-CSharp/ClientPacket/Common/NKMUserProfileData.cs",
      "Assembly-CSharp/ClientPacket/Common/NKMCommonProfile.cs",
    ],
    user: {
      level: 1,
      exp: "0",
      totalExp: "0",
      authLevel: 1,
    },
    army: {
      maxUnitCount: 200,
      maxShipCount: 10,
      maxOperatorCount: 10,
      maxTrophyCount: 2000,
    },
    profile: {
      friendIntro: "",
      mainUnitId: 0,
      mainUnitSkinId: 0,
      mainUnitTacticLevel: 0,
      frameId: 0,
      selfiFrameId: 0,
      titleId: 0,
      emblems: [],
      hasOffice: false,
      privatePvpInvitation: 0,
    },
    userOption: {
      autoRespawn: false,
      actionCameraType: 1,
      trackCamera: true,
      viewSkillCutIn: true,
      autoWarfare: false,
      autoWarfareRepair: true,
      playCutscene: false,
      autoDive: false,
      speedType: 0,
      autoSkillType: 1,
      autoSyncFriendDeck: true,
      defaultPvpAutoRespawn: 0,
      privatePvpInvitation: 0,
    },
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

main();
