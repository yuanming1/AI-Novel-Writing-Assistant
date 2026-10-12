const test = require("node:test");
const assert = require("node:assert/strict");
const {
  allocateChapterBudgets,
  resolveVolumePlanScale,
} = require("../dist/services/novel/volume/volumeChapterBudgetAllocation.js");
const {
  resolveTargetChapterCount,
} = require("../dist/services/novel/volume/volumeBeatSheetChapterBudget.js");

function buildVolume(id, chapterCount) {
  return {
    id,
    chapters: Array.from({ length: chapterCount }, (_, index) => ({ id: `${id}-c${index + 1}` })),
  };
}

function buildBeatSheet(volumeId, spanHints) {
  return {
    volumeId,
    volumeSortOrder: 1,
    status: "confirmed",
    beats: spanHints.map((hint, index) => ({ key: `beat_${index}`, chapterSpanHint: hint })),
  };
}

test("resolveVolumePlanScale falls back to committed routes without a beat sheet", () => {
  const volume = buildVolume("v1", 3);
  assert.equal(resolveVolumePlanScale(volume, []), 3);
  assert.equal(resolveVolumePlanScale(volume, null), 3);
});

test("resolveVolumePlanScale keeps the declared beat-sheet scale for a partially generated volume", () => {
  const volume = buildVolume("v3", 3);
  const beatSheet = buildBeatSheet("v3", ["1-3章", "4-6章", "7-10章", "11-14章", "15-20章", "21-24章", "25-26章"]);
  assert.equal(resolveVolumePlanScale(volume, [beatSheet]), 26);
});

test("weight mode uses the beat-sheet scale so a JIT partially generated volume keeps its planned budget", () => {
  const volumes = [buildVolume("v1", 30), buildVolume("v2", 27), buildVolume("v3", 3)];
  const beatSheets = [
    buildBeatSheet("v3", ["1-3章", "4-6章", "7-10章", "11-14章", "15-20章", "21-24章", "25-26章"]),
  ];
  const budgets = allocateChapterBudgets({ volumeCount: 3, chapterBudget: 80, existingVolumes: volumes, beatSheets });
  assert.equal(budgets.reduce((sum, value) => sum + value, 0), 80);
  assert.ok(budgets[2] >= 20, `expected a near-26-chapter budget for volume 3, got ${budgets[2]}`);
});

test("without beat sheets the legacy weighted behavior is unchanged", () => {
  const volumes = [buildVolume("v1", 30), buildVolume("v2", 27), buildVolume("v3", 3)];
  const budgets = allocateChapterBudgets({ volumeCount: 3, chapterBudget: 80, existingVolumes: volumes });
  assert.equal(budgets[2], 4);
});

test("the regressed beat-sheet span is accepted against the restored budget", () => {
  const volumes = [buildVolume("v1", 30), buildVolume("v2", 27), buildVolume("v3", 3)];
  const beatSheets = [
    buildBeatSheet("v3", ["1-3章", "4-6章", "7-10章", "11-14章", "15-20章", "21-24章", "25-26章"]),
  ];
  const budgets = allocateChapterBudgets({ volumeCount: 3, chapterBudget: 80, existingVolumes: volumes, beatSheets });
  const resolved = resolveTargetChapterCount({
    budgetedChapterCount: Math.max(volumes[2].chapters.length, budgets[2]),
    beatSheetRequiredChapterCount: 26,
  });
  assert.equal(resolved.beatSheetCountAccepted, true);
  assert.equal(resolved.targetChapterCount, 26);
});
