const recordModel = require("../models/recordModel");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000; // let the server finish booting first

async function runPhotoRetentionPurge() {
  try {
    const { recordsPurged, filesDeleted } = await recordModel.purgeExpiredPhotos();
    if (recordsPurged > 0) {
      console.log(
        `Photo retention: removed ${filesDeleted} photo(s) from ${recordsPurged} record(s) older than 3 months.`
      );
    }
  } catch (err) {
    console.error("Photo retention job failed:", err.message);
  }
}

// Runs once shortly after every server start, then every 24 hours — a
// once-a-day job doesn't need a full cron scheduler/extra dependency.
function startPhotoRetentionJob() {
  setTimeout(runPhotoRetentionPurge, STARTUP_DELAY_MS);
  setInterval(runPhotoRetentionPurge, ONE_DAY_MS);
}

module.exports = { startPhotoRetentionJob, runPhotoRetentionPurge };
