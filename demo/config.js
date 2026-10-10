'use strict';

// Settings for the static demo. The sample data itself lives in demo/home/,
// laid out exactly like ~/.claude: real sessions trimmed by extract.js, plus
// any memory/ folders and plugins under .claude/plugins/cache/<marketplace>/
// <plugin>/<version>/. build.js copies that tree into a throwaway home and
// reads it back with the real server.

// What "Organize" answers in the demo, by session id. The real feature asks
// Claude; the demo can't, so it replays an answer the real feature gave.
// A session missing here is reported as skipped.
const organized = {};

const pins = ['826af3c8-a868-47ae-9970-febf277dd4b3'];

const settings = { cleanupPeriodDays: 30 };

// Marketplace repo for each plugin marketplace folder in demo/home, so the
// Plugins tab can show where a plugin came from.
const marketplaces = {
  'claude-plugins-official': 'anthropics/claude-plugins-official',
};

module.exports = { organized, pins, settings, marketplaces };
